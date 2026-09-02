# neveroversell

Holds that cannot oversell. A Postgres library for selling a finite thing exactly once when payment is asynchronous: seats, tickets, stock, appointment slots, rental units, cohort places.

This is the Python client. It ships the same SQL as the TypeScript package, so both languages share one set of guarantees and one database schema. The full documentation, the design notes and the test results live in the [repository README](https://github.com/pavangupta352/neveroversell#readme).

```sh
pip install neveroversell
```

Postgres 13 or newer. No extensions, no Redis, no queue.

```python
from datetime import timedelta
from neveroversell import Inventory

inv = Inventory(
    "postgres://user:pass@host/db",
    hold_ttl=timedelta(minutes=15),        # a basket lives 15 minutes
    payment_window=timedelta(minutes=30),  # once payment starts, 30 minutes; must exceed the TTL
)
inv.migrate()
inv.upsert_resource("flight_AI202_2026-10-01", 180)

held = inv.hold("flight_AI202_2026-10-01", 2, account_id=user.id, idempotency_key=basket.id)
if held.status != "held":
    ...  # "insufficient" (held.available says how many are left), "account_cap", "unknown_resource"

inv.begin_payment(held.hold.id)

# From the return URL and from the webhook, in any order, any number of times:
result = inv.confirm(held.hold.id, payment.id)
match result.status:
    case "confirmed":          fulfil(result.hold)
    case "already_confirmed":  pass
    case "duplicate_payment":  refund(result.payment_ref)          # keep result.existing_payment_ref
    case "payment_ref_in_use": investigate(result.other_hold_id)
    case "expired" | "released": refund(result.payment_ref)
    case "not_found":          pass
```

Run `inv.sweep()` every minute from a scheduler, or `select nos_sweep()` from `pg_cron`. `inv.check()` compares the counters with the rows whenever you want proof.

Every method returns a `Result` with a `status` string and the fields that status needs. Nothing throws for an expected outcome; exceptions are for programmer errors such as a non-positive quantity.

Pass your own `psycopg_pool.ConnectionPool` with `Inventory(pool=...)` to share connections with the rest of your application.
