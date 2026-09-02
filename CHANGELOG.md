# Changelog

All notable changes to this project are recorded here. The format follows Keep a Changelog and the project follows semantic versioning.

## 0.1.0

First release.

- Schema: `nos_settings`, `nos_resources` with `CHECK (held + sold <= total)`, `nos_holds`, `nos_hold_events`, partial unique indexes for idempotency keys and payment references.
- Functions: `nos_hold`, `nos_begin_payment`, `nos_confirm`, `nos_release`, `nos_extend`, `nos_sweep`, `nos_check`, `nos_repair`, `nos_upsert_resource`.
- TypeScript client `createInventory` with typed result unions, a migration runner, and settings validation mirrored by a database constraint.
- Python client `neveroversell.Inventory` on psycopg 3, bundling the same SQL files and sharing the same migration table.
- CLI: `migrate`, `resource`, `sweep`, `show`, `holds`, `check`, `bench`, `throughput`.
- Test suite against a real Postgres: concurrency storms, two-path confirmation races, payment-phase survival, account caps, concurrent sweepers, deadlock soak, database-level defence.
