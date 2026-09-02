import { createApp, fulfilment, inventory, pool } from "./server.js";
import { sign } from "./provider.js";

/**
 * Plays the provider. Runs the server in-process, then fires the browser return and the webhook at
 * the same hold in every order a real system produces, and prints what happened.
 */

const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "rzp_test_key_secret";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "rzp_test_webhook_secret";
const STRIPE_ENDPOINT_SECRET = process.env.STRIPE_ENDPOINT_SECRET ?? "whsec_test";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await inventory.migrate();
  await pool.query("truncate nos_hold_events, nos_holds, nos_resources restart identity cascade");
  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, body, headers });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { status: res.status, body: { text } };
    }
  };

  await inventory.upsertResource({ id: "show_2026-10-01", total: 3 });
  const line = (s: string) => process.stdout.write(s + "\n");
  line(`resource show_2026-10-01: 3 units\n`);

  // Scenario 1: return arrives first, webhook second (the common case on a fast network).
  {
    const { body } = await api("POST", "/checkout", JSON.stringify({ resourceId: "show_2026-10-01", qty: 1, accountId: "alice", basketId: "b1" }), { "content-type": "application/json" });
    const holdId = body.holdId as string;
    const orderId = body.orderId as string;
    const paymentId = "pay_alice_1";
    const ret = await api("GET", `/return/razorpay?hold=${holdId}&order_id=${orderId}&payment_id=${paymentId}&signature=${sign.razorpayCheckout(orderId, paymentId, RAZORPAY_KEY_SECRET)}`);
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: paymentId, notes: { hold_id: holdId } } } } });
    const hook = await api("POST", "/webhooks/razorpay", raw, { "x-razorpay-signature": sign.razorpayWebhook(raw, RAZORPAY_WEBHOOK_SECRET) });
    line(`1. return first, webhook second`);
    line(`   return  -> ${ret.body.status}: ${ret.body.message}`);
    line(`   webhook -> ${hook.body.status}: ${hook.body.message}\n`);
  }

  // Scenario 2: both arrive at the same instant, and the webhook is retried twice more.
  {
    const { body } = await api("POST", "/checkout", JSON.stringify({ resourceId: "show_2026-10-01", qty: 1, accountId: "bob", basketId: "b2" }), { "content-type": "application/json" });
    const holdId = body.holdId as string;
    const paymentId = "pi_bob_1";
    const raw = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: paymentId, metadata: { hold_id: holdId } } } });
    const headers = { "stripe-signature": sign.stripeWebhook(raw, STRIPE_ENDPOINT_SECRET) };
    const orderId = body.orderId as string;
    const [ret, h1, h2, h3] = await Promise.all([
      api("GET", `/return/razorpay?hold=${holdId}&order_id=${orderId}&payment_id=${paymentId}&signature=${sign.razorpayCheckout(orderId, paymentId, RAZORPAY_KEY_SECRET)}`),
      api("POST", "/webhooks/stripe", raw, headers),
      api("POST", "/webhooks/stripe", raw, headers),
      api("POST", "/webhooks/stripe", raw, headers),
    ]);
    line(`2. return and three webhook deliveries at the same instant`);
    for (const [name, r] of [["return", ret], ["webhook", h1], ["webhook", h2], ["webhook", h3]] as const) line(`   ${name.padEnd(7)} -> ${r.body.status}: ${r.body.message}`);
    line("");
  }

  // Scenario 3: the customer paid twice (a retry created a second payment). The second one is refunded.
  {
    const { body } = await api("POST", "/checkout", JSON.stringify({ resourceId: "show_2026-10-01", qty: 1, accountId: "carol", basketId: "b3" }), { "content-type": "application/json" });
    const holdId = body.holdId as string;
    const first = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_carol_1", metadata: { hold_id: holdId } } } });
    const second = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_carol_2", metadata: { hold_id: holdId } } } });
    const a = await api("POST", "/webhooks/stripe", first, { "stripe-signature": sign.stripeWebhook(first, STRIPE_ENDPOINT_SECRET) });
    const b = await api("POST", "/webhooks/stripe", second, { "stripe-signature": sign.stripeWebhook(second, STRIPE_ENDPOINT_SECRET) });
    line(`3. the customer paid twice`);
    line(`   payment 1 -> ${a.body.status}: ${a.body.message}`);
    line(`   payment 2 -> ${b.body.status}: ${b.body.message}\n`);
  }

  // Scenario 4: sold out, then a late webhook for a hold that expired before the money arrived.
  {
    const soldOut = await api("POST", "/checkout", JSON.stringify({ resourceId: "show_2026-10-01", qty: 1, accountId: "dave", basketId: "b4" }), { "content-type": "application/json" });
    line(`4. a fourth buyer: ${soldOut.status} ${JSON.stringify(soldOut.body)}`);

    await inventory.upsertResource({ id: "late_show", total: 1 });
    const held = await inventory.hold({ resourceId: "late_show", qty: 1, accountId: "erin", ttlMs: 150 });
    if (held.status !== "held") throw new Error(held.status);
    await sleep(300);
    await inventory.sweep();
    const raw = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_erin_late", metadata: { hold_id: held.hold.id } } } });
    const late = await api("POST", "/webhooks/stripe", raw, { "stripe-signature": sign.stripeWebhook(raw, STRIPE_ENDPOINT_SECRET) });
    line(`   late webhook after the hold expired -> ${late.body.status}: ${late.body.message}\n`);
  }

  const status = await inventory.status("show_2026-10-01");
  line(`final: ${JSON.stringify(status)}`);
  line(`fulfilled ${fulfilment.fulfilled.length} orders, refunded ${fulfilment.refunded.length} payments, ${fulfilment.investigate.length} to investigate`);
  const drift = (await inventory.check()).filter((c) => c.drift);
  line(`drift: ${drift.length === 0 ? "none" : JSON.stringify(drift)}`);

  server.close();
  await pool.end();
  if (drift.length) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + "\n");
  process.exit(1);
});
