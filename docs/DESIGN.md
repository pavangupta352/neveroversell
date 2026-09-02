# Design notes

Why the library is built the way it is. Read this before changing any function.

## The problem in one sentence

A finite thing must be sold at most once while payment is asynchronous, which means two customers can race for the last unit, a hold can outlive the customer's interest, a checkout can be killed while the bank is still thinking, and the money can arrive twice or too late.

## One lock, one order

Every function that changes a resource's counters or its holds begins with

```sql
select * from nos_resources where id = $1 for no key update;
```

That single row lock serialises everything that can touch the resource. Functions that start from a hold id (`confirm`, `release`, `extend`, `begin_payment`) first read the hold's `resource_id` without a lock, then take the resource lock, then re-read the hold under it. Taking the hold row's lock first would create a second lock order and, under load, deadlocks against `hold()` and `sweep()`.

`FOR NO KEY UPDATE` is used instead of `FOR UPDATE` because nothing changes the resource's primary key; the weaker mode does not block inserts of rows that reference the resource, which keeps the lock as narrow as it can be.

When the account cap is account-wide, `hold()` takes `pg_advisory_xact_lock(hashtext('nos:account:' || account_id))` before the resource lock. Same order every time, so still no deadlocks.

## Why not SERIALIZABLE

Serializable isolation would also prevent overselling, but it does so by aborting one of two conflicting transactions, so every client in every language needs a retry loop, and a PL/pgSQL function cannot reliably retry its own aborted transaction. With the row lock the second transaction simply waits, reads the fresh counters when the lock is granted, and gets a definitive answer. The guarantee lives entirely inside the SQL functions, which is what lets the clients stay thin and identical.

## Counters and the CHECK constraint

`nos_resources` carries `total`, `held` and `sold`. Under the lock, counting rows would be correct too, but counters keep the hot path O(1). The cost is that a bug in any code path could let a counter drift from the rows. Three things pay for that:

1. `CHECK (held + sold <= total)`: the database refuses to commit an oversell regardless of what the application did.
2. `nos_check()`: recomputes both counters from the rows and reports drift.
3. The concurrency and soak tests assert no drift after every storm.

## States and timers

```
held ──begin_payment──▶ awaiting_payment ──confirm──▶ confirmed
  │                          │
  ├── release ──▶ released ◀─┤
  │                          │
  └── TTL ──▶ expired ◀── payment deadline
```

A plain `held` row lives for `hold_ttl`. Once payment starts it becomes `awaiting_payment` and lives until `payment_deadline`, which is `payment_window` after the start. `nos_settings` enforces `payment_window > hold_ttl`, so a customer on the bank's page is never killed by the timer that was meant for abandoned baskets.

`hold()` expires only plain `held` rows of its own resource, so one customer's request can never expire another customer's payment in progress. Payment-phase rows are expired only by `sweep()`.

`confirm` on an `awaiting_payment` row whose deadline has passed but which the sweeper has not yet reached is honoured: the customer paid and the units are still held. `confirm` on an `expired` or `released` row never revives it; the status carries the payment reference so the caller can refund.

## The two confirmation paths

The browser return and the provider webhook both call `confirm(hold_id, payment_ref)`. The outcomes are exhaustive:

| Situation | Status | Caller does |
|---|---|---|
| First confirmation | `confirmed` | fulfil |
| Same payment again | `already_confirmed` | nothing |
| Different payment for the same hold | `duplicate_payment` | refund the new one |
| This payment already bought another hold | `payment_ref_in_use` | investigate |
| Hold expired or released before the money arrived | `expired`, `released` | refund |

The partial unique index on `payment_ref` makes `payment_ref_in_use` a database guarantee, not an application check.

## Idempotency of hold

A client that times out and retries would otherwise create two holds for one basket. `hold()` accepts an idempotency key, enforced by a partial unique index on `(resource_id, account_id, idempotency_key)`. A concurrent duplicate that loses the race gets `unique_violation`, which the function catches and answers with `replayed` and the winning hold.

## Sweeping

`sweep()` finds resources with due holds, locks each in id order, and runs one conditional `UPDATE` that flips due rows to `expired`. Two sweepers running at once serialise per resource; the second finds nothing left to flip. Each hold is expired exactly once, and the event log records who expired it and why.

## Throughput

All operations on one resource queue on one row lock. That is plenty for clinics, classes, events and most drops. For a single SKU flash sale with tens of thousands of simultaneous buyers, shard the counter across several resources or put a queue in front. Neither is in this library. Measure with `neveroversell throughput`.

## Modelling

A specific seat is a resource with `total = 1`. A general-admission section is a resource with `total = 500`. A clinic slot is a resource with `total = 1`. Overbooking is `total` set above physical capacity. Multi-resource atomic holds are deliberately absent; when they arrive they must lock resources in sorted id order.
