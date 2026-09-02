import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createInventory, type Inventory } from "../src/index.js";
import { countBy, makePool, resetTables, sleep } from "./setup.js";

let pool: pg.Pool;
let inv: Inventory;

beforeAll(async () => {
  pool = makePool(60);
  inv = createInventory({ pool });
  await inv.migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetTables(pool);
  await inv.applySettings();
});

async function noDrift(): Promise<void> {
  const rows = await inv.check();
  expect(rows.filter((r) => r.drift)).toEqual([]);
}

async function heldOrThrow(input: Parameters<Inventory["hold"]>[0]): Promise<string> {
  const r = await inv.hold(input);
  if (r.status !== "held") throw new Error(`expected held, got ${r.status}`);
  return r.hold.id;
}

describe("3. TTL expiry", () => {
  it("an expired hold is swept by the next hold on the same resource, and by sweep()", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    const first = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a", ttlMs: 100 });
    expect((await inv.hold({ resourceId: "r", qty: 1, accountId: "b" })).status).toBe("insufficient");
    await sleep(200);
    const second = await inv.hold({ resourceId: "r", qty: 1, accountId: "b" });
    expect(second.status).toBe("held");
    const events = await inv.events(first);
    expect(events.at(-1)).toMatchObject({ event: "expired", detail: { by: "hold", reason: "ttl" } });
    expect(await inv.status("r")).toMatchObject({ held: 1 });
    await noDrift();
  });

  it("sweep reports per resource and is a no-op when nothing is due", async () => {
    await inv.upsertResource({ id: "r1", total: 10 });
    await inv.upsertResource({ id: "r2", total: 10 });
    await heldOrThrow({ resourceId: "r1", qty: 2, accountId: "a", ttlMs: 100 });
    await heldOrThrow({ resourceId: "r1", qty: 3, accountId: "b", ttlMs: 100 });
    await heldOrThrow({ resourceId: "r2", qty: 4, accountId: "c", ttlMs: 100 });
    await heldOrThrow({ resourceId: "r2", qty: 1, accountId: "d", ttlMs: 60_000 });
    expect(await inv.sweep()).toEqual([]);
    await sleep(200);
    expect(await inv.sweep()).toEqual([
      { resourceId: "r1", expiredHolds: 2, expiredQty: 5 },
      { resourceId: "r2", expiredHolds: 1, expiredQty: 4 },
    ]);
    expect(await inv.sweep()).toEqual([]);
    expect(await inv.status("r2")).toMatchObject({ held: 1, available: 9 });
    await noDrift();
  });
});

describe("4. the payment phase outlives the TTL", () => {
  it("a hold in payment survives the TTL and is expired only after its deadline, only by sweep", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    const id = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a", ttlMs: 100 });
    const bp = await inv.beginPayment({ holdId: id, windowMs: 600 });
    expect(bp.status).toBe("awaiting_payment");
    await sleep(250);
    expect(await inv.sweep()).toEqual([]);
    expect((await inv.hold({ resourceId: "r", qty: 1, accountId: "b" })).status).toBe("insufficient");
    expect(await inv.status("r")).toMatchObject({ held: 1, heldPaying: 1, heldPlain: 0 });
    await sleep(450);
    expect((await inv.hold({ resourceId: "r", qty: 1, accountId: "b" })).status).toBe("insufficient");
    expect(await inv.sweep()).toEqual([{ resourceId: "r", expiredHolds: 1, expiredQty: 1 }]);
    const events = await inv.events(id);
    expect(events.at(-1)).toMatchObject({ event: "expired", detail: { by: "sweep", reason: "payment_window" } });
    await noDrift();
  });

  it("confirm during the payment window succeeds even after the plain TTL has passed", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    const id = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a", ttlMs: 100 });
    await inv.beginPayment({ holdId: id, windowMs: 2000 });
    await sleep(250);
    expect((await inv.confirm({ holdId: id, paymentRef: "pay_slow_bank" })).status).toBe("confirmed");
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 1 });
    await noDrift();
  });

  it("beginPayment is idempotent and refuses an expired plain hold", async () => {
    await inv.upsertResource({ id: "r", total: 2 });
    const live = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a" });
    expect((await inv.beginPayment({ holdId: live })).status).toBe("awaiting_payment");
    expect((await inv.beginPayment({ holdId: live })).status).toBe("replayed");
    const dead = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "b", ttlMs: 50 });
    await sleep(120);
    expect((await inv.beginPayment({ holdId: dead })).status).toBe("expired");
    expect(await inv.status("r")).toMatchObject({ held: 1, heldPaying: 1 });
    await noDrift();
  });
});

describe("9. account caps", () => {
  it("account-wide cap holds across resources under concurrency", async () => {
    const capped = createInventory({ pool, accountCap: 3, capScope: "account" });
    await capped.applySettings();
    await capped.upsertResource({ id: "r1", total: 100 });
    await capped.upsertResource({ id: "r2", total: 100 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => capped.hold({ resourceId: i % 2 ? "r1" : "r2", qty: 1, accountId: "greedy" })),
    );
    expect(countBy(results)).toEqual({ held: 3, account_cap: 17 });
    const s1 = await capped.status("r1");
    const s2 = await capped.status("r2");
    expect((s1?.held ?? 0) + (s2?.held ?? 0)).toBe(3);
    expect((await capped.hold({ resourceId: "r1", qty: 1, accountId: "someone-else" })).status).toBe("held");
    await noDrift();
  });

  it("per-resource cap applies to each resource separately", async () => {
    const capped = createInventory({ pool, accountCap: 3, capScope: "resource" });
    await capped.applySettings();
    await capped.upsertResource({ id: "r1", total: 100 });
    await capped.upsertResource({ id: "r2", total: 100 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => capped.hold({ resourceId: i % 2 ? "r1" : "r2", qty: 1, accountId: "greedy" })),
    );
    expect(countBy(results)).toEqual({ held: 6, account_cap: 14 });
    expect(await capped.status("r1")).toMatchObject({ held: 3 });
    expect(await capped.status("r2")).toMatchObject({ held: 3 });
    await noDrift();
  });

  it("released and expired holds free up cap", async () => {
    const capped = createInventory({ pool, accountCap: 1, capScope: "resource" });
    await capped.applySettings();
    await capped.upsertResource({ id: "r", total: 10 });
    const id = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a" });
    expect((await capped.hold({ resourceId: "r", qty: 1, accountId: "a" })).status).toBe("account_cap");
    await capped.release({ holdId: id });
    expect((await capped.hold({ resourceId: "r", qty: 1, accountId: "a" })).status).toBe("held");
  });
});

describe("11. two sweepers at once", () => {
  it("expire 300 holds exactly once between them", async () => {
    for (let r = 0; r < 30; r++) await inv.upsertResource({ id: `r${r}`, total: 20 });
    // A TTL long enough that creating the holds cannot expire the early ones inline through hold().
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => heldOrThrow({ resourceId: `r${i % 30}`, qty: 1, accountId: `a${i}`, ttlMs: 1500 })),
    );
    await sleep(1700);
    const [a, b] = await Promise.all([inv.sweep(), inv.sweep()]);
    const bySweep = [...a, ...b].reduce((n, row) => n + row.expiredHolds, 0);
    const { rows } = await pool.query(
      `select count(*)::int as total,
              count(distinct hold_id)::int as distinct_holds,
              count(*) filter (where detail->>'by' = 'sweep')::int as by_sweep
         from nos_hold_events where event = 'expired'`,
    );
    // Every hold expired exactly once, and the two sweepers between them account for every sweep expiry.
    expect(rows[0]).toEqual({ total: 300, distinct_holds: 300, by_sweep: bySweep });
    expect(bySweep).toBe(300);
    const statuses = await Promise.all(Array.from({ length: 30 }, (_, r) => inv.status(`r${r}`)));
    expect(statuses.every((s) => s?.held === 0)).toBe(true);
    await noDrift();
  });
});

describe("16. extend", () => {
  it("extends a plain hold a bounded number of times and refuses afterwards", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    const id = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a", ttlMs: 500 });
    const before = (await inv.holds({ resourceId: "r" }))[0]?.expiresAt.getTime() ?? 0;
    const first = await inv.extend({ holdId: id, byMs: 60_000 });
    expect(first.status).toBe("extended");
    if (first.status !== "extended") throw new Error();
    expect(first.hold.expiresAt.getTime()).toBeGreaterThan(before + 59_000);
    expect((await inv.extend({ holdId: id, byMs: 60_000 })).status).toBe("not_extendable");
  });

  it("refuses expired and paying holds", async () => {
    await inv.upsertResource({ id: "r", total: 2 });
    const dead = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a", ttlMs: 50 });
    await sleep(120);
    expect((await inv.extend({ holdId: dead })).status).toBe("not_extendable");
    const paying = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "b" });
    await inv.beginPayment({ holdId: paying });
    expect((await inv.extend({ holdId: paying })).status).toBe("not_extendable");
  });
});

describe("release", () => {
  it("is idempotent and never touches a sale", async () => {
    await inv.upsertResource({ id: "r", total: 2 });
    const id = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "a" });
    expect((await inv.release({ holdId: id })).status).toBe("released");
    expect((await inv.release({ holdId: id })).status).toBe("already_released");
    const sold = await heldOrThrow({ resourceId: "r", qty: 1, accountId: "b" });
    await inv.confirm({ holdId: sold, paymentRef: "pay_1" });
    expect((await inv.release({ holdId: sold })).status).toBe("confirmed");
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 1, available: 1 });
    await noDrift();
  });
});

describe("13. soak: interleaved operations never deadlock or drift", () => {
  it("runs a mixed workload for a few seconds", async () => {
    const resources = 12;
    for (let r = 0; r < resources; r++) await inv.upsertResource({ id: `s${r}`, total: 6 });
    const liveHolds: string[] = [];
    const errors: Array<{ code?: string; message: string }> = [];
    const deadline = Date.now() + 5000;
    let n = 0;

    async function worker(w: number): Promise<void> {
      while (Date.now() < deadline) {
        const op = Math.random();
        try {
          if (op < 0.4) {
            const r = await inv.hold({ resourceId: `s${(n++ + w) % resources}`, qty: 1 + (n % 2), accountId: `acct-${n % 40}`, ttlMs: 300 + (n % 5) * 100 });
            if (r.status === "held") liveHolds.push(r.hold.id);
          } else if (op < 0.55 && liveHolds.length) {
            await inv.beginPayment({ holdId: liveHolds[Math.floor(Math.random() * liveHolds.length)] as string, windowMs: 1500 });
          } else if (op < 0.75 && liveHolds.length) {
            const id = liveHolds[Math.floor(Math.random() * liveHolds.length)] as string;
            await inv.confirm({ holdId: id, paymentRef: `pay-${id.slice(0, 8)}-${n % 3}` });
          } else if (op < 0.85 && liveHolds.length) {
            await inv.release({ holdId: liveHolds[Math.floor(Math.random() * liveHolds.length)] as string });
          } else if (op < 0.92 && liveHolds.length) {
            await inv.extend({ holdId: liveHolds[Math.floor(Math.random() * liveHolds.length)] as string, byMs: 200 });
          } else {
            await inv.sweep();
          }
        } catch (err) {
          errors.push({ code: (err as { code?: string }).code, message: (err as Error).message });
        }
      }
    }

    await Promise.all(Array.from({ length: 24 }, (_, w) => worker(w)));
    expect(errors.filter((e) => e.code === "40P01")).toEqual([]);
    expect(errors).toEqual([]);
    await noDrift();
    const statuses = await Promise.all(Array.from({ length: resources }, (_, r) => inv.status(`s${r}`)));
    for (const s of statuses) expect((s?.held ?? 0) + (s?.sold ?? 0)).toBeLessThanOrEqual(s?.total ?? 0);
  });
});
