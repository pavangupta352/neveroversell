## What this changes

## Why

## Guarantees

- [ ] Every function still locks the resource row first
- [ ] Availability still comes from the counters
- [ ] New behaviour has a test that fails without the change
- [ ] `npm run typecheck` and `npm test` pass locally against Postgres
