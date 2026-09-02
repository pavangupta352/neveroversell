# neveroversell

Holds that cannot oversell. A Postgres library for selling a finite thing exactly once when payment is asynchronous: seats, tickets, stock, appointment slots, rental units, cohort places.

[![ci](https://github.com/pavangupta352/neveroversell/actions/workflows/ci.yml/badge.svg)](https://github.com/pavangupta352/neveroversell/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/neveroversell)](https://www.npmjs.com/package/neveroversell)
[![PyPI](https://img.shields.io/pypi/v/neveroversell)](https://pypi.org/project/neveroversell/)
[![license](https://img.shields.io/badge/license-MIT-black)](LICENSE)

![500 buyers race for 10 units: this library holds exactly 10 with zero oversold, the naive implementation sells 72](docs/assets/bench.gif)

```
$ neveroversell bench --units 10 --buyers 500
500 concurrent purchases · 10 units · held: 10 · oversold: 0 · check: no drift · 542 ms

$ neveroversell bench --units 10 --buyers 500 --naive
500 concurrent purchases · 10 units · sold: 72 · oversold: 62
```

The first line is this library. The second is the read-then-write implementation every codebase starts with. Same database, same 500 buyers, same 10 units.

## What you get

- **Holds with a time to live.** Take units for a basket. If nobody pays, they come back on their own.
- **A payment phase with a longer deadline.** Once the customer is on the bank's page the hold cannot be killed by the basket timer. The database refuses a configuration where it could.
- **Confirmation that survives both paths.** The browser return and the provider webhook both call `confirm`. Whichever arrives first fulfils; the other is a no-op. A second payment for the same hold is reported so you can refund it. A payment that already bought another hold is refused. A payment that arrives after the hold expired never revives it.
- **Explicit release and bounded extension.** For "remove from basket" and "you have two more minutes".
- **A sweeper two workers can run at once.** Every hold is expired exactly once, with a record of who expired it and why.
- **A drift check.** Counters are compared with rows on demand, and a `CHECK` constraint makes an oversell impossible to commit even if application code is wrong.
- **One migration, readable SQL.** Everything lives in four tables and ten SQL functions with a thin TypeScript client on top. Use the SQL from any language.

## Install

```sh
npm install neveroversell pg
```

Postgres 13 or newer. Nothing else: no extensions, no Redis, no queue, no service.

Works with any payment provider, because it never talks to one. You pass in whatever payment id Razorpay, Stripe, PayPal, Paddle, Adyen or Cashfree gave you, and the library only cares that the same id is not used twice.

## Sixty seconds

```ts
import pg from "pg";
import { createInventory } from "neveroversell";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const inv = createInventory({
  pool,
  holdTtlMs: 15 * 60_000,       // a basket lives 15 minutes
  paymentWindowMs: 30 * 60_000, // once payment starts, 30 minutes; must exceed the TTL
});

await inv.migrate();
await inv.upsertResource({ id: "flight_AI202_2026-10-01", total: 180 });

// 1. The customer picks two seats.
const held = await inv.hold({ resourceId: "flight_AI202_2026-10-01", qty: 2, accountId: user.id, idempotencyKey: basket.id });
if (held.status !== "held") {
  // "insufficient" (with the available count), "account_cap", or "unknown_resource"
  throw new SoldOut(held);
}

// 2. They click pay. The hold now lives until the payment deadline, not the basket TTL.
await inv.beginPayment({ holdId: held.hold.id });

// 3. Money arrives, from the return URL and from the webhook, in any order, any number of times.
const result = await inv.confirm({ holdId: held.hold.id, paymentRef: payment.id });
switch (result.status) {
  case "confirmed":          await fulfil(result.hold); break;     // exactly one path lands here
  case "already_confirmed":  break;                                // the other path already did
  case "duplicate_payment":  await refund(result.paymentRef); break;   // customer paid twice
  case "payment_ref_in_use": await investigate(result.otherHoldId); break;
  case "expired":
  case "released":           await refund(result.paymentRef); break;   // money arrived too late
  case "not_found":          break;
}
```

Run `sweep` every minute from cron, a worker, or `pg_cron`:

```ts
await inv.sweep(); // [{ resourceId, expiredHolds, expiredQty }, ...]
```

```sql
-- or, with pg_cron
select cron.schedule('neveroversell-sweep', '* * * * *', $$select nos_sweep()$$);
```

## Every outcome of confirm

| What happened | `status` | You do |
|---|---|---|
| First confirmation of this hold | `confirmed` | Fulfil the order |
| Same payment reference again (the other path, a webhook retry) | `already_confirmed` | Nothing |
| A different payment reference for an already confirmed hold | `duplicate_payment` | Refund `paymentRef`, keep `existingPaymentRef` |
| This payment reference already bought a different hold | `payment_ref_in_use` | Investigate `otherHoldId` |
| The hold expired before the money arrived | `expired` | Refund `paymentRef` |
| The hold was released before the money arrived | `released` | Refund `paymentRef` |
| No such hold | `not_found` | Log it |

Nothing here throws. Every outcome your code has to handle is a value.

## How a hold lives

```
                hold()                beginPayment()             confirm()
  (none) ───────────────▶  held  ─────────────────────▶ awaiting_payment ─────────▶ confirmed
                            │                                │
                            │ release()                      │ release()
                            ├───────────────▶ released ◀─────┤
                            │                                │
                            │ TTL elapsed                    │ payment deadline elapsed
                            └───────────────▶ expired  ◀─────┘
```

- A plain hold lives for `holdTtlMs`. The next `hold` on the same resource, or `sweep`, expires it.
- After `beginPayment` it lives until `paymentWindowMs` after payment started. Only `sweep` can expire it, never another customer's request.
- `paymentWindowMs` must be larger than `holdTtlMs`. The client checks it, and so does a constraint in the database.
- `confirmed`, `released` and `expired` are final. Nothing revives a hold.

## How it works

Every function takes one row lock, on the resource, with `FOR NO KEY UPDATE`, under the default `READ COMMITTED` isolation. Under that lock it expires what is due, reads the three counters (`total`, `held`, `sold`), decides, and writes. There is no `SERIALIZABLE`, so there are no serialization failures and no client retry loops in any language.

The counters are the source of truth for availability, so the hot path never counts rows. A `CHECK (held + sold <= total)` constraint sits underneath: if any code path were ever wrong, the database rejects the transaction instead of overselling. `check()` recomputes the counters from the rows whenever you want proof.

Idempotency is enforced by the database too: a partial unique index on `(resource_id, account_id, idempotency_key)` means a retried `hold` returns the original, and a partial unique index on `payment_ref` means one payment can never buy two holds.

The full reasoning, including the lock order and why the sweeper cannot double-expire, is in [docs/DESIGN.md](docs/DESIGN.md).

## API

```ts
createInventory({ pool, holdTtlMs?, paymentWindowMs?, accountCap?, capScope?, maxExtensions?, extensionMs? })

inv.migrate()                                          // apply sql/*.sql, push settings, idempotent
inv.upsertResource({ id, total })                      // created | updated | capacity_below_committed
inv.hold({ resourceId, qty, accountId, idempotencyKey?, ttlMs? })
                                                       // held | replayed | insufficient | account_cap | unknown_resource
inv.beginPayment({ holdId, windowMs? })                // awaiting_payment | replayed | expired | confirmed | released | not_found
inv.confirm({ holdId, paymentRef })                    // see the table above
inv.release({ holdId, reason? })                       // released | already_released | confirmed | expired | not_found
inv.extend({ holdId, byMs? })                          // extended | not_extendable | not_found
inv.sweep({ limit? })                                  // per-resource counts of what was expired
inv.check()                                            // counters versus rows, drift flag per resource
inv.repair(resourceId)                                 // recompute one resource's counters, explicit
inv.status(resourceId)                                 // total, held, sold, available, plain versus paying
inv.holds({ resourceId?, state?, olderThanMs?, limit? })
inv.events(holdId)                                     // the append-only history of one hold
```

Every result is a discriminated union on `status`, so `switch` statements are exhaustive.

### Settings

| Option | Default | Meaning |
|---|---|---|
| `holdTtlMs` | 15 minutes | Life of a plain hold |
| `paymentWindowMs` | 30 minutes | Life of a hold after payment starts. Must exceed `holdTtlMs` |
| `accountCap` | none | Maximum units one account may hold at once |
| `capScope` | `resource` | Whether the cap counts per resource or across all resources |
| `maxExtensions` | 1 | How many times a plain hold may be extended |
| `extensionMs` | 5 minutes | How much each extension adds |

Settings live in `nos_settings` inside the database, so every worker and every language sees the same values.

## CLI

```
neveroversell migrate                          apply the migrations
neveroversell resource <id> --total <n>        create a resource or change its capacity
neveroversell sweep [--limit <n>]              expire what is due
neveroversell show <resource>                  counters and active holds
neveroversell holds [--resource <id>] [--state <s>] [--older-than 10m]
neveroversell check [--repair <resource>]      counters versus rows
neveroversell bench [--units 10] [--buyers 500] [--naive]
neveroversell throughput [--seconds 5] [--concurrency 32]
```

Pass `--db <url>` or set `DATABASE_URL`. Add `--json` for machine output. `check` exits 3 on drift, so it can run as a monitor.

## Throughput

All operations on one resource queue on one row lock. On an Apple M4 laptop with Postgres 16 in Docker:

```
$ neveroversell throughput --seconds 5 --concurrency 8
17,601 holds in 5.0 s on one resource · 3,519 holds/s

$ neveroversell bench --units 50 --buyers 2000
2000 concurrent purchases · 50 units · held: 50 · oversold: 0 · check: no drift · 814 ms
```

That is enough for clinics, classes, events and most product drops. A single SKU flash sale with tens of thousands of simultaneous buyers needs the counter sharded across several resources or a queue in front, which this library deliberately does not do. Run the command on your own hardware; the numbers above are not a promise.

## Modelling

- **A specific seat** is a resource with `total: 1`. **A section** is a resource with `total: 500`. **A clinic slot** is a resource with `total: 1`.
- **Overbooking** is `total` set above physical capacity. No feature needed.
- **Several things in one basket** (a seat plus parking): take one hold per resource, confirm each with the same payment reference plus a suffix, and release the others if one fails. Atomic multi-resource holds are deliberately not in this version because they need a second lock order.
- **Serverless**: every call is one SQL function, so there is nothing to keep alive. Run `sweep` from a scheduled function or `pg_cron`.
- **Connection poolers** in transaction mode are fine: no function relies on session state.

## Python

The same library, the same SQL, from Python:

```sh
pip install neveroversell
```

```python
from datetime import timedelta
from neveroversell import Inventory

inv = Inventory("postgres://user:pass@host/db", hold_ttl=timedelta(minutes=15), payment_window=timedelta(minutes=30))
inv.migrate()
inv.upsert_resource("flight_AI202_2026-10-01", 180)

held = inv.hold("flight_AI202_2026-10-01", 2, account_id=user.id, idempotency_key=basket.id)
inv.begin_payment(held.hold.id)
result = inv.confirm(held.hold.id, payment.id)   # result.status is one of the outcomes in the table above
```

Both clients apply the same migration files and record them in the same table, so a TypeScript service and a Python worker can share one database without ceremony. Details in [python/README.md](python/README.md).

## Using the SQL without the client

The functions are plain PL/pgSQL. Apply `sql/001_schema.sql`, `sql/002_functions.sql` and `sql/003_views.sql`, then:

```sql
select * from nos_upsert_resource('gig', 100);
select * from nos_hold('gig', 2, 'alice', 'basket-1');
select * from nos_begin_payment('<hold id>');
select * from nos_confirm('<hold id>', 'pay_123');
select * from nos_release('<hold id>', 'changed mind');
select * from nos_extend('<hold id>');
select * from nos_sweep();
select * from nos_check();
```

Every function returns the same `nos_result` row: `status`, `hold_id`, `resource_id`, `account_id`, `qty`, `state`, `expires_at`, `payment_deadline`, `payment_ref`, `existing_payment_ref`, `other_hold_id`, `available`.

## What the test suite proves

Every test runs against a real Postgres 16, never a mock.

- 500 buyers racing for 10 units: exactly 10 holds succeed, and the invariant `held + sold <= total` holds at every observation during the storm.
- The naive check-then-insert implementation oversells under the same load. That is the second block at the top of this file.
- The browser return and the webhook racing to confirm one hold: exactly one `confirmed`, the rest `already_confirmed`, counters moved once.
- A second payment for a confirmed hold is `duplicate_payment`; one payment for two holds is `payment_ref_in_use`, even against a direct SQL update.
- A confirmation after the sweeper expired the hold, after the TTL passed, or after an explicit release: never revived, payment reference returned for refund.
- A hold in the payment phase survives the basket TTL and is expired only after its deadline, only by the sweeper.
- Account caps hold under concurrency, per resource and across resources.
- Twenty concurrent retries with one idempotency key create exactly one hold.
- Two sweepers running at once expire 300 holds exactly once between them.
- A five second soak of interleaved holds, payments, confirmations, releases, extensions and sweeps across 12 resources produces no deadlock and no drift.
- A direct `UPDATE` that would oversell is rejected by the database.

```sh
npm run db:up && npm test
```

## Example: two confirmation paths, one hold

[`examples/two-paths-express`](examples/two-paths-express) is an Express server where the return URL and the provider webhook both confirm the same hold, with the signature checks for Razorpay Checkout, Razorpay webhooks and Stripe webhooks written out in full. Its simulator plays the provider and prints what happens when both paths arrive at once, when the customer pays twice, and when a webhook arrives after the hold expired.

![The simulator: return and webhook racing, three webhook retries, a double payment refunded, a late webhook after expiry refunded, no drift](docs/assets/two-paths.gif)

## What this is not

Not a booking system: no seat maps, no pricing, no checkout UI, no payment SDKs. Not a queue and not a cache: no Redis, nothing to keep alive. Not a multi-resource transaction manager, yet. It is one primitive with an expiry policy, small enough to audit in an afternoon.

## Prior art

The pattern is well known and implemented inside every e-commerce framework: Medusa's inventory module reservations, Saleor's stock allocations, Solidus and Spree inventory units. What did not exist was the primitive on its own, for plain Postgres, with the payment phase, the two-path confirmation outcomes and a test suite that proves them. If you know of one, open an issue and it will be linked here.

## License

MIT
