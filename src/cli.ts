#!/usr/bin/env node
import { parseArgs } from "node:util";
import pg from "pg";
import { createInventory } from "./index.js";
import { runBench, runThroughput } from "./bench.js";
import type { HoldState } from "./types.js";

const USAGE = `neveroversell <command> [options]

Commands
  migrate                         apply the SQL migrations (idempotent)
  resource <id> --total <n>       create a resource or change its capacity
  sweep [--limit <n>]             expire holds past their TTL or payment deadline
  show <resource>                 counters and active holds for one resource
  holds [--resource <id>] [--state <s>] [--older-than <10m>] [--limit <n>]
  check [--repair <resource>]     compare counters with rows; optionally repair one resource
  bench [--units 10] [--buyers 500] [--qty 1] [--naive] [--gap-ms 2]
  throughput [--seconds 5] [--concurrency 32]

Options
  --db <url>      connection string (default: DATABASE_URL)
  --json          machine-readable output
  -h, --help      this text
`;

function parseDuration(text: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`cannot parse duration "${text}" (use 500ms, 30s, 10m, 2h, 1d)`);
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h" | "d";
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      total: { type: "string" },
      limit: { type: "string" },
      resource: { type: "string" },
      state: { type: "string" },
      "older-than": { type: "string" },
      repair: { type: "string" },
      units: { type: "string", default: "10" },
      buyers: { type: "string", default: "500" },
      qty: { type: "string", default: "1" },
      naive: { type: "boolean", default: false },
      "gap-ms": { type: "string", default: "2" },
      seconds: { type: "string", default: "5" },
      concurrency: { type: "string", default: "32" },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const connectionString = values.db ?? process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("neveroversell: pass --db <url> or set DATABASE_URL\n");
    return 1;
  }
  const pool = new pg.Pool({ connectionString, max: command === "bench" || command === "throughput" ? 64 : 8 });
  const inv = createInventory({ pool });
  const out = (data: unknown, text: string): void => {
    process.stdout.write(values.json ? JSON.stringify(data, null, 2) + "\n" : text + "\n");
  };

  try {
    switch (command) {
      case "migrate": {
        const applied = await inv.migrate();
        out({ applied }, applied.length ? `applied: ${applied.join(", ")}` : "already up to date");
        return 0;
      }
      case "resource": {
        const id = positionals[1];
        if (!id || values.total === undefined) throw new Error("usage: resource <id> --total <n>");
        const r = await inv.upsertResource({ id, total: Number(values.total) });
        out(r, `${r.status}: ${r.resourceId} available ${r.available}`);
        return r.status === "capacity_below_committed" ? 2 : 0;
      }
      case "sweep": {
        const rows = await inv.sweep({ limit: values.limit ? Number(values.limit) : 1000 });
        const total = rows.reduce((n, r) => n + r.expiredHolds, 0);
        out(rows, rows.length ? rows.map((r) => `${r.resourceId}: ${r.expiredHolds} holds, ${r.expiredQty} units`).join("\n") + `\nexpired ${total} holds` : "nothing to expire");
        return 0;
      }
      case "show": {
        const id = positionals[1];
        if (!id) throw new Error("usage: show <resource>");
        const s = await inv.status(id);
        if (!s) {
          process.stderr.write(`no resource ${id}\n`);
          return 2;
        }
        const active = await inv.holds({ resourceId: id, limit: 50 });
        const lines = [
          `${s.resourceId}: total ${s.total} · held ${s.held} (plain ${s.heldPlain}, paying ${s.heldPaying}) · sold ${s.sold} · available ${s.available}`,
          ...active
            .filter((h) => h.state === "held" || h.state === "awaiting_payment")
            .map((h) => `  ${h.id}  ${h.state.padEnd(16)} qty ${h.qty}  account ${h.accountId}  expires ${h.expiresAt.toISOString()}`),
        ];
        out({ status: s, holds: active }, lines.join("\n"));
        return 0;
      }
      case "holds": {
        const filter: Parameters<typeof inv.holds>[0] = {};
        if (values.resource) filter.resourceId = values.resource;
        if (values.state) filter.state = values.state as HoldState;
        if (values["older-than"]) filter.olderThanMs = parseDuration(values["older-than"]);
        if (values.limit) filter.limit = Number(values.limit);
        const rows = await inv.holds(filter);
        out(
          rows,
          rows.length
            ? rows.map((h) => `${h.id}  ${h.resourceId}  ${h.state.padEnd(16)} qty ${h.qty}  account ${h.accountId}  expires ${h.expiresAt.toISOString()}`).join("\n")
            : "no holds match",
        );
        return 0;
      }
      case "check": {
        if (values.repair) {
          const r = await inv.repair(values.repair);
          if (!r) {
            process.stderr.write(`no resource ${values.repair}\n`);
            return 2;
          }
          out(r, `${r.resourceId}: held ${r.heldBefore} -> ${r.heldAfter}, sold ${r.soldBefore} -> ${r.soldAfter}`);
          return 0;
        }
        const rows = await inv.check();
        const drift = rows.filter((r) => r.drift);
        out(
          rows,
          rows.length
            ? rows.map((r) => `${r.drift ? "DRIFT " : "ok    "} ${r.resourceId}: held ${r.held} (rows ${r.heldByRows}), sold ${r.sold} (rows ${r.soldByRows})`).join("\n")
            : "no resources",
        );
        return drift.length ? 3 : 0;
      }
      case "bench": {
        const r = await runBench(pool, {
          units: Number(values.units),
          buyers: Number(values.buyers),
          qty: Number(values.qty),
          naive: values.naive,
          gapMs: Number(values["gap-ms"]),
        });
        out(r, r.line);
        return r.oversold > 0 && !values.naive ? 4 : 0;
      }
      case "throughput": {
        const r = await runThroughput(pool, { seconds: Number(values.seconds), concurrency: Number(values.concurrency) });
        out(r, `${r.holds.toLocaleString()} holds in ${r.seconds.toFixed(1)} s on one resource · ${r.holdsPerSecond.toLocaleString()} holds/s`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`neveroversell: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
