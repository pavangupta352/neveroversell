import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createInventory, type Inventory } from "../src/index.js";
import { runBench } from "../src/bench.js";
import { countBy, makePool, resetTables, sleep } from "./setup.js";

let pool: pg.Pool;
let inv: Inventory;

beforeAll(async () => {
  pool = makePool(80);
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

describe("migrations", () => {
  it("are idempotent and keep settings", async () => {
    expect(await inv.migrate()).toEqual([]);
    const { rows } = await pool.query("select hold_ttl::text as ttl, payment_window::text as win from nos_settings");
    expect(rows[0]).toEqual({ ttl: "00:15:00", win: "00:30:00" });
  });
});

describe("1. concurrent holds cannot oversell", () => {
  it("500 buyers, 10 units: exactly 10 holds succeed", async () => {
    await inv.upsertResource({ id: "gig", total: 10 });
    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) => inv.hold({ resourceId: "gig", qty: 1, accountId: `buyer-${i}` })),
    );
    expect(countBy(results)).toEqual({ held: 10, insufficient: 490 });
    expect(await inv.status("gig")).toMatchObject({ total: 10, held: 10, sold: 0, available: 0 });
    await noDrift();
  });

  it("300 buyers wanting 3 each, 10 units: 9 units held, then 1 left that nobody can take", async () => {
    await inv.upsertResource({ id: "gig", total: 10 });
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) => inv.hold({ resourceId: "gig", qty: 3, accountId: `buyer-${i}` })),
    );
    expect(countBy(results)).toEqual({ held: 3, insufficient: 297 });
    expect(await inv.status("gig")).toMatchObject({ held: 9, available: 1 });
    const one = await inv.hold({ resourceId: "gig", qty: 1, accountId: "late" });
    expect(one.status).toBe("held");
    expect(await inv.status("gig")).toMatchObject({ held: 10, available: 0 });
    await noDrift();
  });

  it("the invariant is never violated at any point during the storm", async () => {
    await inv.upsertResource({ id: "gig", total: 25 });
    let worst = 0;
    const observer = (async () => {
      for (let i = 0; i < 60; i++) {
        const s = await inv.status("gig");
        if (s) worst = Math.max(worst, s.held + s.sold - s.total);
        await sleep(5);
      }
    })();
    await Promise.all(Array.from({ length: 400 }, (_, i) => inv.hold({ resourceId: "gig", qty: 1 + (i % 3), accountId: `b-${i}` })));
    await observer;
    expect(worst).toBeLessThanOrEqual(0);
    await noDrift();
  });
});

describe("2. the naive implementation oversells under the same load", () => {
  it("check-then-insert sells more than it has", async () => {
    const r = await runBench(pool, { units: 10, buyers: 200, naive: true, gapMs: 5 });
    expect(r.committed).toBeGreaterThan(10);
    expect(r.oversold).toBeGreaterThan(0);
  });

  it("the library does not, with the same buyers", async () => {
    const r = await runBench(pool, { units: 10, buyers: 200 });
    expect(r.succeeded).toBe(10);
    expect(r.oversold).toBe(0);
    expect(r.drift).toBe(false);
  });
});

describe("5. confirm is idempotent across both confirmation paths", () => {
  it("same payment reference twice: confirmed, then already_confirmed with the same hold", async () => {
    await inv.upsertResource({ id: "r", total: 5 });
    const h = await inv.hold({ resourceId: "r", qty: 2, accountId: "a" });
    if (h.status !== "held") throw new Error(h.status);
    const first = await inv.confirm({ holdId: h.hold.id, paymentRef: "pay_1" });
    const second = await inv.confirm({ holdId: h.hold.id, paymentRef: "pay_1" });
    expect(first.status).toBe("confirmed");
    expect(second.status).toBe("already_confirmed");
    if (second.status !== "already_confirmed") throw new Error();
    expect(second.hold.id).toBe(h.hold.id);
    expect(second.hold.paymentRef).toBe("pay_1");
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 2, available: 3 });
    await noDrift();
  });

  it("browser return and webhook racing: exactly one confirmed, counters moved once", async () => {
    await inv.upsertResource({ id: "r", total: 5 });
    const h = await inv.hold({ resourceId: "r", qty: 1, accountId: "a" });
    if (h.status !== "held") throw new Error(h.status);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => inv.confirm({ holdId: h.hold.id, paymentRef: "pay_race" })),
    );
    expect(countBy(results)).toEqual({ confirmed: 1, already_confirmed: 11 });
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 1 });
    await noDrift();
  });
});

describe("6. a different payment reference for a confirmed hold is a duplicate payment", () => {
  it("returns duplicate_payment with both references and changes nothing", async () => {
    await inv.upsertResource({ id: "r", total: 5 });
    const h = await inv.hold({ resourceId: "r", qty: 1, accountId: "a" });
    if (h.status !== "held") throw new Error(h.status);
    await inv.confirm({ holdId: h.hold.id, paymentRef: "pay_A" });
    const dup = await inv.confirm({ holdId: h.hold.id, paymentRef: "pay_B" });
    expect(dup).toMatchObject({ status: "duplicate_payment", paymentRef: "pay_B", existingPaymentRef: "pay_A" });
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 1 });
    const events = await inv.events(h.hold.id);
    expect(events.map((e) => e.event)).toEqual(["held", "confirmed", "duplicate_payment"]);
    await noDrift();
  });
});

describe("7. one payment cannot buy two holds", () => {
  it("sequential: the second hold gets payment_ref_in_use pointing at the first", async () => {
    await inv.upsertResource({ id: "r", total: 5 });
    const h1 = await inv.hold({ resourceId: "r", qty: 1, accountId: "a" });
    const h2 = await inv.hold({ resourceId: "r", qty: 1, accountId: "b" });
    if (h1.status !== "held" || h2.status !== "held") throw new Error();
    expect((await inv.confirm({ holdId: h1.hold.id, paymentRef: "pay_X" })).status).toBe("confirmed");
    const r = await inv.confirm({ holdId: h2.hold.id, paymentRef: "pay_X" });
    expect(r).toMatchObject({ status: "payment_ref_in_use", otherHoldId: h1.hold.id, paymentRef: "pay_X" });
    expect(await inv.status("r")).toMatchObject({ held: 1, sold: 1 });
    await noDrift();
  });

  it("concurrent on two resources: the unique index lets exactly one through", async () => {
    await inv.upsertResource({ id: "r1", total: 5 });
    await inv.upsertResource({ id: "r2", total: 5 });
    const h1 = await inv.hold({ resourceId: "r1", qty: 1, accountId: "a" });
    const h2 = await inv.hold({ resourceId: "r2", qty: 1, accountId: "a" });
    if (h1.status !== "held" || h2.status !== "held") throw new Error();
    const results = await Promise.all([
      inv.confirm({ holdId: h1.hold.id, paymentRef: "pay_shared" }),
      inv.confirm({ holdId: h2.hold.id, paymentRef: "pay_shared" }),
    ]);
    expect(countBy(results)).toEqual({ confirmed: 1, payment_ref_in_use: 1 });
    const { rows } = await pool.query("select count(*)::int as n from nos_holds where payment_ref = 'pay_shared'");
    expect(rows[0].n).toBe(1);
    await noDrift();
  });

  it("even a direct SQL update cannot give two holds one payment reference", async () => {
    await inv.upsertResource({ id: "r", total: 5 });
    const h1 = await inv.hold({ resourceId: "r", qty: 1, accountId: "a" });
    const h2 = await inv.hold({ resourceId: "r", qty: 1, accountId: "b" });
    if (h1.status !== "held" || h2.status !== "held") throw new Error();
    await inv.confirm({ holdId: h1.hold.id, paymentRef: "pay_Y" });
    await expect(pool.query("update nos_holds set payment_ref = 'pay_Y' where id = $1", [h2.hold.id])).rejects.toMatchObject({ code: "23505" });
  });
});

describe("8. a late confirmation never revives a hold", () => {
  it("after the sweeper expired it: expired, with the payment reference to refund", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    const h = await inv.hold({ resourceId: "r", qty: 1, accountId: "a", ttlMs: 100 });
    if (h.status !== "held") throw new Error(h.status);
    await sleep(200);
    expect(await inv.sweep()).toEqual([{ resourceId: "r", expiredHolds: 1, expiredQty: 1 }]);
    const late = await inv.confirm({ holdId: h.hold.id, paymentRef: "pay_late" });
    expect(late).toMatchObject({ status: "expired", paymentRef: "pay_late" });
    if (late.status !== "expired") throw new Error();
    expect(late.hold.state).toBe("expired");
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 0, available: 1 });
    const again = await inv.hold({ resourceId: "r", qty: 1, accountId: "someone-else" });
    expect(again.status).toBe("held");
    await noDrift();
  });

  it("after the TTL passed but before any sweep: confirm itself expires it", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    const h = await inv.hold({ resourceId: "r", qty: 1, accountId: "a", ttlMs: 100 });
    if (h.status !== "held") throw new Error(h.status);
    await sleep(200);
    const late = await inv.confirm({ holdId: h.hold.id, paymentRef: "pay_late" });
    expect(late.status).toBe("expired");
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 0 });
    const events = await inv.events(h.hold.id);
    expect(events.at(-1)).toMatchObject({ event: "expired", detail: { by: "confirm", reason: "ttl", payment_ref: "pay_late" } });
    await noDrift();
  });

  it("after an explicit release: released, with the payment reference", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    const h = await inv.hold({ resourceId: "r", qty: 1, accountId: "a" });
    if (h.status !== "held") throw new Error(h.status);
    expect((await inv.release({ holdId: h.hold.id, reason: "basket_emptied" })).status).toBe("released");
    const late = await inv.confirm({ holdId: h.hold.id, paymentRef: "pay_late" });
    expect(late).toMatchObject({ status: "released", paymentRef: "pay_late" });
    expect(await inv.status("r")).toMatchObject({ held: 0, sold: 0, available: 1 });
    await noDrift();
  });
});

describe("10. idempotency key on hold", () => {
  it("a retry returns the same hold and holds nothing extra", async () => {
    await inv.upsertResource({ id: "r", total: 5 });
    const a = await inv.hold({ resourceId: "r", qty: 2, accountId: "a", idempotencyKey: "basket-1" });
    const b = await inv.hold({ resourceId: "r", qty: 2, accountId: "a", idempotencyKey: "basket-1" });
    if (a.status !== "held" || b.status !== "replayed") throw new Error(`${a.status} ${b.status}`);
    expect(b.hold.id).toBe(a.hold.id);
    expect(await inv.status("r")).toMatchObject({ held: 2 });
  });

  it("20 concurrent retries create exactly one hold", async () => {
    await inv.upsertResource({ id: "r", total: 50 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => inv.hold({ resourceId: "r", qty: 1, accountId: "a", idempotencyKey: "same" })),
    );
    const ids = new Set(results.map((r) => (r.status === "held" || r.status === "replayed" ? r.hold.id : "?")));
    expect(ids.size).toBe(1);
    expect(countBy(results).held).toBe(1);
    expect(await inv.status("r")).toMatchObject({ held: 1 });
    await noDrift();
  });
});

describe("12. configuration is validated in the client and in the database", () => {
  it("the client refuses a payment window shorter than the hold TTL", () => {
    expect(() => createInventory({ pool, holdTtlMs: 20_000, paymentWindowMs: 10_000 })).toThrow(/must exceed holdTtlMs/);
    expect(() => createInventory({ pool, holdTtlMs: 20_000, paymentWindowMs: 20_000 })).toThrow(/must exceed holdTtlMs/);
  });

  it("the database refuses the same thing", async () => {
    await expect(
      pool.query("update nos_settings set hold_ttl = interval '2 minutes', payment_window = interval '1 minute'"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("applySettings surfaces a database rejection as a readable error", async () => {
    const bad = createInventory({ pool, holdTtlMs: 1000, paymentWindowMs: 2000 });
    await pool.query("update nos_settings set payment_window = interval '1 hour', hold_ttl = interval '59 minutes'");
    await expect(bad.applySettings()).resolves.toBeUndefined();
  });
});

describe("15. the database is the last line of defence", () => {
  it("a direct update that would oversell is rejected by the CHECK constraint", async () => {
    await inv.upsertResource({ id: "r", total: 3 });
    await inv.hold({ resourceId: "r", qty: 2, accountId: "a" });
    await expect(pool.query("update nos_resources set sold = total where id = 'r'")).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("update nos_resources set held = held + 2 where id = 'r'")).rejects.toMatchObject({ code: "23514" });
  });

  it("lowering capacity below what is committed is refused with a status, not an exception", async () => {
    await inv.upsertResource({ id: "r", total: 5 });
    await inv.hold({ resourceId: "r", qty: 4, accountId: "a" });
    expect(await inv.upsertResource({ id: "r", total: 3 })).toMatchObject({ status: "capacity_below_committed", available: 1 });
    expect(await inv.upsertResource({ id: "r", total: 4 })).toMatchObject({ status: "updated", available: 0 });
  });
});

describe("edges", () => {
  it("unknown resource is a status", async () => {
    expect(await inv.hold({ resourceId: "nope", qty: 1, accountId: "a" })).toEqual({ status: "unknown_resource", resourceId: "nope" });
  });

  it("not_found statuses for unknown hold ids", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect(await inv.confirm({ holdId: id, paymentRef: "p" })).toEqual({ status: "not_found", paymentRef: "p" });
    expect(await inv.release({ holdId: id })).toEqual({ status: "not_found" });
    expect(await inv.extend({ holdId: id })).toEqual({ status: "not_found" });
    expect(await inv.beginPayment({ holdId: id })).toEqual({ status: "not_found" });
  });

  it("programmer errors raise", async () => {
    await inv.upsertResource({ id: "r", total: 1 });
    await expect(inv.hold({ resourceId: "r", qty: 0, accountId: "a" })).rejects.toThrow(/qty must be positive/);
    await expect(inv.hold({ resourceId: "r", qty: 1, accountId: "" })).rejects.toThrow(/account id is required/);
  });
});
