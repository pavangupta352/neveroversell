import type { Pool } from "pg";

/**
 * The implementation everyone writes first: read the counter, decide in application code, write.
 * It exists only so `neveroversell bench --naive` can show what happens under concurrency.
 *
 * `gapMs` widens the window between the read and the write. The window exists anyway: in a real
 * application it contains at least one network round trip, and usually a payment call.
 */
export async function naiveSetup(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists naive_resources (id text primary key, total integer not null, sold integer not null default 0);
    create table if not exists naive_orders (id bigserial primary key, resource_id text not null, account_id text not null, qty integer not null);
  `);
}

export async function naiveUpsertResource(pool: Pool, id: string, total: number): Promise<void> {
  await pool.query(
    "insert into naive_resources (id, total, sold) values ($1, $2, 0) on conflict (id) do update set total = excluded.total, sold = 0",
    [id, total],
  );
  await pool.query("delete from naive_orders where resource_id = $1", [id]);
}

export async function naiveBuy(
  pool: Pool,
  input: { resourceId: string; qty: number; accountId: string; gapMs?: number },
): Promise<"sold" | "insufficient"> {
  const { resourceId, qty, accountId, gapMs = 2 } = input;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ total: number; sold: number }>(
      "select total, sold from naive_resources where id = $1",
      [resourceId],
    );
    const r = rows[0];
    if (!r || r.sold + qty > r.total) {
      await client.query("rollback");
      return "insufficient";
    }
    if (gapMs > 0) await client.query("select pg_sleep($1)", [gapMs / 1000]);
    await client.query("insert into naive_orders (resource_id, account_id, qty) values ($1, $2, $3)", [resourceId, accountId, qty]);
    await client.query("update naive_resources set sold = sold + $2 where id = $1", [resourceId, qty]);
    await client.query("commit");
    return "sold";
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function naiveStatus(pool: Pool, resourceId: string): Promise<{ total: number; sold: number; orders: number }> {
  const { rows } = await pool.query<{ total: number; sold: number; orders: string }>(
    `select r.total, r.sold, (select count(*) from naive_orders o where o.resource_id = r.id) as orders
       from naive_resources r where r.id = $1`,
    [resourceId],
  );
  const r = rows[0];
  if (!r) throw new Error(`naive resource ${resourceId} not found`);
  return { total: r.total, sold: r.sold, orders: Number(r.orders) };
}
