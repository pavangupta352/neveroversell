# Contributing

Thanks for taking the time. This library is small on purpose: four tables, ten SQL functions, a thin client. The bar for a change is that it keeps the guarantees provable by the test suite.

## Setup

```sh
git clone https://github.com/pavangupta352/neveroversell
cd neveroversell
npm install
npm run db:up          # Postgres 16 in Docker on port 54329
npm test
```

`DATABASE_URL` overrides the default connection string if you prefer your own Postgres (13 or newer).

## Ground rules for changes

- Every function locks the resource row first, with `FOR NO KEY UPDATE`, under the default `READ COMMITTED` isolation. Do not introduce `SERIALIZABLE`, client-side retries, or a second lock order.
- Availability comes from the counters on `nos_resources`, never from counting rows on the hot path. The `CHECK (held + sold <= total)` constraint stays.
- Expected outcomes are statuses in `nos_result`. Exceptions are for programmer errors only.
- All time decisions use the database clock.
- A behaviour change needs a test in `test/` that fails before the change and passes after it. The concurrency tests are the specification; keep them green.
- No floats, no Redis, no queues, no payment SDKs, no UI.

## The SQL lives in one place

`sql/` at the repository root is the source. The Python package bundles a copy under `python/neveroversell/sql/`; run `npm run sync:sql` after editing SQL, and the Python test suite fails if the two ever differ.

## Python

```sh
cd python
uv venv && uv pip install -e ".[dev]"     # or: python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest -q
```

## Running one test

```sh
npx vitest run -t "two sweepers"
```

## Style

TypeScript strict mode, `npm run typecheck` clean. SQL in lower case, one statement per idea, comments where a decision is not obvious from the code. Plain punctuation in prose.

## Releasing

Both packages carry the same version. To release:

1. Bump `version` in `package.json` and in `python/pyproject.toml`, add the entry to `CHANGELOG.md`.
2. `npm run sync:sql` if any SQL changed, then `npm test` and `python/.venv/bin/pytest -q`.
3. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.

The release workflow re-runs the full suite, checks that the tag, `package.json` and `pyproject.toml` agree, builds the Python distributions, and publishes both packages through trusted publishing, so no registry token is stored anywhere.

## Reporting a bug

Open an issue with the Postgres version, the sequence of calls, and the statuses you got and expected. A failing test is the best bug report there is.
