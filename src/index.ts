import type { Pool } from "pg";
import { migrate as runMigrations } from "./migrate.js";
import type {
  BeginPaymentResult,
  CheckRow,
  ConfirmResult,
  ExtendResult,
  Hold,
  HoldEvent,
  HoldResult,
  HoldState,
  ReleaseResult,
  RepairRow,
  ResourceStatus,
  ResultRow,
  SweepRow,
  UpsertResourceResult,
} from "./types.js";

export * from "./types.js";
export { migrate, defaultSqlDir } from "./migrate.js";

export interface InventoryOptions {
  pool: Pool;
  /** How long a plain hold lives before it expires. Default 15 minutes. */
  holdTtlMs?: number;
  /** How long a hold survives once payment has started. Must exceed holdTtlMs. Default 30 minutes. */
  paymentWindowMs?: number;
  /** Maximum units one account may hold at once, or null for no cap. Default null. */
  accountCap?: number | null;
  /** Whether the cap applies per resource or across all resources. Default "resource". */
  capScope?: "resource" | "account";
  /** How many times a plain hold may be extended. Default 1. */
  maxExtensions?: number;
  /** How much each extension adds. Default 5 minutes. */
  extensionMs?: number;
}

export interface Inventory {
  /** Apply the SQL migrations and push the configured settings into nos_settings. Idempotent. */
  migrate(): Promise<string[]>;
  /** Push the configured settings into nos_settings without migrating. */
  applySettings(): Promise<void>;
  upsertResource(input: { id: string; total: number }): Promise<UpsertResourceResult>;
  hold(input: { resourceId: string; qty: number; accountId: string; idempotencyKey?: string; ttlMs?: number }): Promise<HoldResult>;
  beginPayment(input: { holdId: string; windowMs?: number }): Promise<BeginPaymentResult>;
  confirm(input: { holdId: string; paymentRef: string }): Promise<ConfirmResult>;
  release(input: { holdId: string; reason?: string }): Promise<ReleaseResult>;
  extend(input: { holdId: string; byMs?: number }): Promise<ExtendResult>;
  sweep(input?: { limit?: number }): Promise<SweepRow[]>;
  check(): Promise<CheckRow[]>;
  repair(resourceId: string): Promise<RepairRow | null>;
  status(resourceId: string): Promise<ResourceStatus | null>;
  holds(filter?: { resourceId?: string; state?: HoldState; olderThanMs?: number; limit?: number }): Promise<Hold[]>;
  events(holdId: string): Promise<HoldEvent[]>;
}

const MS = (ms: number): string => `${Math.round(ms)} milliseconds`;

export function createInventory(options: InventoryOptions): Inventory {
  const {
    pool,
    holdTtlMs = 15 * 60_000,
    paymentWindowMs = 30 * 60_000,
    accountCap = null,
    capScope = "resource",
    maxExtensions = 1,
    extensionMs = 5 * 60_000,
  } = options;

  if (!(holdTtlMs > 0)) throw new Error("neveroversell: holdTtlMs must be positive");
  if (!(paymentWindowMs > holdTtlMs)) {
    throw new Error(
      `neveroversell: paymentWindowMs (${paymentWindowMs}) must exceed holdTtlMs (${holdTtlMs}); otherwise the sweeper can kill a live checkout`,
    );
  }
  if (accountCap !== null && !(accountCap > 0)) throw new Error("neveroversell: accountCap must be positive or null");
  if (!(maxExtensions >= 0)) throw new Error("neveroversell: maxExtensions must be zero or positive");
  if (!(extensionMs > 0)) throw new Error("neveroversell: extensionMs must be positive");

  async function call(fn: string, args: unknown[]): Promise<ResultRow> {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await pool.query<ResultRow>(`select * from ${fn}(${placeholders})`, args);
    const row = rows[0];
    if (!row) throw new Error(`neveroversell: ${fn} returned no row`);
    return row;
  }

  function toHold(r: ResultRow): Hold {
    return {
      id: r.hold_id as string,
      resourceId: r.resource_id as string,
      accountId: r.account_id as string,
      qty: r.qty as number,
      state: r.state as HoldState,
      expiresAt: r.expires_at as Date,
      paymentDeadline: r.payment_deadline,
      paymentRef: r.payment_ref,
    };
  }

  async function applySettings(): Promise<void> {
    try {
      await pool.query(
        `update nos_settings
            set hold_ttl = $1::interval, payment_window = $2::interval, account_cap = $3,
                cap_scope = $4, max_extensions = $5, extension = $6::interval
          where id`,
        [MS(holdTtlMs), MS(paymentWindowMs), accountCap, capScope, maxExtensions, MS(extensionMs)],
      );
    } catch (err) {
      const e = err as { code?: string; message: string };
      if (e.code === "23514") {
        throw new Error(`neveroversell: the database rejected these settings (${e.message})`, { cause: err });
      }
      throw err;
    }
  }

  return {
    async migrate() {
      const applied = await runMigrations(pool);
      await applySettings();
      return applied;
    },

    applySettings,

    async upsertResource({ id, total }) {
      const r = await call("nos_upsert_resource", [id, total]);
      return {
        status: r.status as UpsertResourceResult["status"],
        resourceId: r.resource_id as string,
        available: r.available as number,
      };
    },

    async hold({ resourceId, qty, accountId, idempotencyKey, ttlMs }) {
      const r = await call("nos_hold", [resourceId, qty, accountId, idempotencyKey ?? null, ttlMs === undefined ? null : MS(ttlMs)]);
      switch (r.status) {
        case "held":
          return { status: "held", hold: toHold(r), available: r.available as number };
        case "replayed":
          return { status: "replayed", hold: toHold(r) };
        case "insufficient":
        case "account_cap":
          return { status: r.status, resourceId: r.resource_id as string, available: r.available as number };
        case "unknown_resource":
          return { status: "unknown_resource", resourceId: r.resource_id as string };
        default:
          throw new Error(`neveroversell: unexpected hold status ${r.status}`);
      }
    },

    async beginPayment({ holdId, windowMs }) {
      const r = await call("nos_begin_payment", [holdId, windowMs === undefined ? null : MS(windowMs)]);
      if (r.status === "not_found") return { status: "not_found" };
      return { status: r.status as Exclude<BeginPaymentResult["status"], "not_found">, hold: toHold(r) };
    },

    async confirm({ holdId, paymentRef }) {
      const r = await call("nos_confirm", [holdId, paymentRef]);
      switch (r.status) {
        case "confirmed":
        case "already_confirmed":
          return { status: r.status, hold: toHold(r) };
        case "duplicate_payment":
          return {
            status: "duplicate_payment",
            hold: toHold(r),
            paymentRef: r.payment_ref as string,
            existingPaymentRef: r.existing_payment_ref as string,
          };
        case "payment_ref_in_use":
          return { status: "payment_ref_in_use", hold: toHold(r), paymentRef: r.payment_ref as string, otherHoldId: r.other_hold_id as string };
        case "expired":
        case "released":
          return { status: r.status, hold: toHold(r), paymentRef: r.payment_ref as string };
        case "not_found":
          return { status: "not_found", paymentRef: r.payment_ref as string };
        default:
          throw new Error(`neveroversell: unexpected confirm status ${r.status}`);
      }
    },

    async release({ holdId, reason }) {
      const r = await call("nos_release", [holdId, reason ?? null]);
      if (r.status === "not_found") return { status: "not_found" };
      return { status: r.status as Exclude<ReleaseResult["status"], "not_found">, hold: toHold(r) };
    },

    async extend({ holdId, byMs }) {
      const r = await call("nos_extend", [holdId, byMs === undefined ? null : MS(byMs)]);
      if (r.status === "not_found") return { status: "not_found" };
      return { status: r.status as Exclude<ExtendResult["status"], "not_found">, hold: toHold(r) };
    },

    async sweep({ limit = 1000 } = {}) {
      const { rows } = await pool.query<{ resource_id: string; expired_holds: number; expired_qty: number }>(
        "select * from nos_sweep($1)",
        [limit],
      );
      return rows.map((r) => ({ resourceId: r.resource_id, expiredHolds: r.expired_holds, expiredQty: r.expired_qty }));
    },

    async check() {
      const { rows } = await pool.query<{
        resource_id: string;
        held: number;
        held_by_rows: string | number;
        sold: number;
        sold_by_rows: string | number;
        drift: boolean;
      }>("select * from nos_check()");
      return rows.map((r) => ({
        resourceId: r.resource_id,
        held: r.held,
        heldByRows: Number(r.held_by_rows),
        sold: r.sold,
        soldByRows: Number(r.sold_by_rows),
        drift: r.drift,
      }));
    },

    async repair(resourceId) {
      const { rows } = await pool.query<{
        resource_id: string;
        held_before: number;
        held_after: number;
        sold_before: number;
        sold_after: number;
      }>("select * from nos_repair($1)", [resourceId]);
      const r = rows[0];
      if (!r) return null;
      return { resourceId: r.resource_id, heldBefore: r.held_before, heldAfter: r.held_after, soldBefore: r.sold_before, soldAfter: r.sold_after };
    },

    async status(resourceId) {
      const { rows } = await pool.query<{
        resource_id: string;
        total: number;
        held: number;
        sold: number;
        available: number;
        held_plain: number;
        held_paying: number;
      }>("select * from nos_resource_status where resource_id = $1", [resourceId]);
      const r = rows[0];
      if (!r) return null;
      return {
        resourceId: r.resource_id,
        total: r.total,
        held: r.held,
        sold: r.sold,
        available: r.available,
        heldPlain: r.held_plain,
        heldPaying: r.held_paying,
      };
    },

    async holds({ resourceId, state, olderThanMs, limit = 200 } = {}) {
      const { rows } = await pool.query<{
        id: string;
        resource_id: string;
        account_id: string;
        qty: number;
        state: HoldState;
        expires_at: Date;
        payment_deadline: Date | null;
        payment_ref: string | null;
      }>(
        `select id, resource_id, account_id, qty, state, expires_at, payment_deadline, payment_ref
           from nos_holds
          where ($1::text is null or resource_id = $1)
            and ($2::nos_hold_state is null or state = $2)
            and ($3::interval is null or created_at <= clock_timestamp() - $3::interval)
          order by created_at asc
          limit $4`,
        [resourceId ?? null, state ?? null, olderThanMs === undefined ? null : MS(olderThanMs), limit],
      );
      return rows.map((r) => ({
        id: r.id,
        resourceId: r.resource_id,
        accountId: r.account_id,
        qty: r.qty,
        state: r.state,
        expiresAt: r.expires_at,
        paymentDeadline: r.payment_deadline,
        paymentRef: r.payment_ref,
      }));
    },

    async events(holdId) {
      const { rows } = await pool.query<{ id: string; hold_id: string; event: string; detail: Record<string, unknown>; at: Date }>(
        "select id, hold_id, event, detail, at from nos_hold_events where hold_id = $1 order by id",
        [holdId],
      );
      return rows.map((r) => ({ id: Number(r.id), holdId: r.hold_id, event: r.event, detail: r.detail, at: r.at }));
    },
  };
}
