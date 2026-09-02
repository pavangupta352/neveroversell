import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";

/** The sql/ directory shipped with the package: ../sql relative to dist/ or src/. */
export const defaultSqlDir = fileURLToPath(new URL("../sql/", import.meta.url));

/**
 * Apply every sql/*.sql file that has not been applied yet, in name order, each in its own transaction.
 * Concurrent migrators serialise on an advisory lock. Returns the names applied in this call.
 */
export async function migrate(pool: Pool, sqlDir: string = defaultSqlDir): Promise<string[]> {
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(hashtext('nos_migrations'))");
    await client.query(
      "create table if not exists nos_migrations (name text primary key, applied_at timestamptz not null default clock_timestamp())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("select name from nos_migrations")).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(sqlDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into nos_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`neveroversell migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('nos_migrations'))").catch(() => undefined);
    client.release();
  }
  return applied;
}
