export type HoldState = "held" | "awaiting_payment" | "confirmed" | "released" | "expired";

export interface Hold {
  id: string;
  resourceId: string;
  accountId: string;
  qty: number;
  state: HoldState;
  expiresAt: Date;
  paymentDeadline: Date | null;
  paymentRef: string | null;
}

export type HoldResult =
  | { status: "held"; hold: Hold; available: number }
  | { status: "replayed"; hold: Hold }
  | { status: "insufficient"; resourceId: string; available: number }
  | { status: "account_cap"; resourceId: string; available: number }
  | { status: "unknown_resource"; resourceId: string };

export type BeginPaymentResult =
  | { status: "awaiting_payment" | "replayed" | "expired" | "confirmed" | "released"; hold: Hold }
  | { status: "not_found" };

export type ConfirmResult =
  | { status: "confirmed" | "already_confirmed"; hold: Hold }
  | { status: "duplicate_payment"; hold: Hold; paymentRef: string; existingPaymentRef: string }
  | { status: "payment_ref_in_use"; hold: Hold; paymentRef: string; otherHoldId: string }
  | { status: "expired" | "released"; hold: Hold; paymentRef: string }
  | { status: "not_found"; paymentRef: string };

export type ReleaseResult =
  | { status: "released" | "already_released" | "confirmed" | "expired"; hold: Hold }
  | { status: "not_found" };

export type ExtendResult = { status: "extended" | "not_extendable"; hold: Hold } | { status: "not_found" };

export interface UpsertResourceResult {
  status: "created" | "updated" | "capacity_below_committed";
  resourceId: string;
  available: number;
}

export interface SweepRow {
  resourceId: string;
  expiredHolds: number;
  expiredQty: number;
}

export interface CheckRow {
  resourceId: string;
  held: number;
  heldByRows: number;
  sold: number;
  soldByRows: number;
  drift: boolean;
}

export interface RepairRow {
  resourceId: string;
  heldBefore: number;
  heldAfter: number;
  soldBefore: number;
  soldAfter: number;
}

export interface ResourceStatus {
  resourceId: string;
  total: number;
  held: number;
  sold: number;
  available: number;
  heldPlain: number;
  heldPaying: number;
}

export interface HoldEvent {
  id: number;
  holdId: string;
  event: string;
  detail: Record<string, unknown>;
  at: Date;
}

/** Raw shape of the nos_result composite as returned by `select * from nos_fn(...)`. */
export interface ResultRow {
  status: string;
  hold_id: string | null;
  resource_id: string | null;
  account_id: string | null;
  qty: number | null;
  state: HoldState | null;
  expires_at: Date | null;
  payment_deadline: Date | null;
  payment_ref: string | null;
  existing_payment_ref: string | null;
  other_hold_id: string | null;
  available: number | null;
}
