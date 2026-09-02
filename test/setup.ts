import pg from "pg";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nos:nos@127.0.0.1:54329/nos";

export function makePool(max = 40): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max });
}

/** Empty every table and restore default settings. Keeps the schema, so migrations run once per file. */
export async function resetTables(pool: pg.Pool): Promise<void> {
  await pool.query("truncate nos_hold_events, nos_holds, nos_resources restart identity cascade");
  await pool.query(
    "update nos_settings set hold_ttl = default, payment_window = default, account_cap = default, cap_scope = default, max_extensions = default, extension = default",
  );
  await pool.query("drop table if exists naive_orders, naive_resources");
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function countBy<T extends { status: string }>(rows: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}
