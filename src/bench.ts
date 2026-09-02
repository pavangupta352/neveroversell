import type { Pool } from "pg";
import { createInventory } from "./index.js";
import { naiveBuy, naiveSetup, naiveStatus, naiveUpsertResource } from "./naive.js";

export interface BenchOptions {
  units: number;
  buyers: number;
  qty?: number;
  naive?: boolean;
  /** Only used by the naive path: the read-to-write gap in milliseconds. */
  gapMs?: number;
  resourceId?: string;
}

export interface BenchResult {
  mode: "neveroversell" | "naive";
  units: number;
  buyers: number;
  qty: number;
  succeeded: number;
  committed: number;
  oversold: number;
  drift: boolean | null;
  elapsedMs: number;
  line: string;
}

/** Fire `buyers` concurrent purchases at one resource and report what the database ended up with. */
export async function runBench(pool: Pool, options: BenchOptions): Promise<BenchResult> {
  const { units, buyers, qty = 1, naive = false, gapMs = 2 } = options;
  const resourceId = options.resourceId ?? `bench_${Date.now().toString(36)}`;
  const buyersList = Array.from({ length: buyers }, (_, i) => `buyer-${i}`);

  if (naive) {
    await naiveSetup(pool);
    await naiveUpsertResource(pool, resourceId, units);
    const started = performance.now();
    const results = await Promise.all(buyersList.map((accountId) => naiveBuy(pool, { resourceId, qty, accountId, gapMs })));
    const elapsedMs = performance.now() - started;
    const succeeded = results.filter((r) => r === "sold").length;
    const s = await naiveStatus(pool, resourceId);
    const oversold = Math.max(0, s.sold - s.total);
    const line = `${buyers} concurrent purchases · ${units} units · sold: ${s.sold} · oversold: ${oversold}`;
    return { mode: "naive", units, buyers, qty, succeeded, committed: s.sold, oversold, drift: null, elapsedMs, line };
  }

  const inv = createInventory({ pool });
  await inv.upsertResource({ id: resourceId, total: units });
  const started = performance.now();
  const results = await Promise.all(buyersList.map((accountId) => inv.hold({ resourceId, qty, accountId })));
  const elapsedMs = performance.now() - started;
  const succeeded = results.filter((r) => r.status === "held").length;
  const status = await inv.status(resourceId);
  const check = (await inv.check()).find((c) => c.resourceId === resourceId);
  const committed = (status?.held ?? 0) + (status?.sold ?? 0);
  const oversold = Math.max(0, committed - units);
  const drift = check?.drift ?? null;
  const line =
    `${buyers} concurrent purchases · ${units} units · held: ${status?.held ?? 0} · oversold: ${oversold}` +
    ` · check: ${drift ? "DRIFT" : "no drift"} · ${Math.round(elapsedMs).toLocaleString()} ms`;
  return { mode: "neveroversell", units, buyers, qty, succeeded, committed, oversold, drift, elapsedMs, line };
}

/** Sustained throughput on a single hot resource: how many holds per second one row lock can serve. */
export async function runThroughput(
  pool: Pool,
  options: { seconds?: number; concurrency?: number; resourceId?: string } = {},
): Promise<{ holds: number; seconds: number; holdsPerSecond: number }> {
  const { seconds = 5, concurrency = 32 } = options;
  const resourceId = options.resourceId ?? `throughput_${Date.now().toString(36)}`;
  const inv = createInventory({ pool });
  await inv.upsertResource({ id: resourceId, total: 2_000_000_000 });
  const deadline = performance.now() + seconds * 1000;
  let holds = 0;
  let n = 0;
  async function worker(): Promise<void> {
    while (performance.now() < deadline) {
      const r = await inv.hold({ resourceId, qty: 1, accountId: `w-${n++}` });
      if (r.status === "held") holds++;
    }
  }
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsed = (performance.now() - started) / 1000;
  return { holds, seconds: elapsed, holdsPerSecond: Math.round(holds / elapsed) };
}
