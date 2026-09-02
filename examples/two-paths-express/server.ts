import express from "express";
import pg from "pg";
import { createInventory, type ConfirmResult } from "neveroversell";
import { verifyRazorpayCheckout, verifyRazorpayWebhook, verifyStripeWebhook } from "./provider.js";

/**
 * The shape every payment flow has: take a hold, start payment, then TWO things try to confirm it.
 *
 *   1. The browser comes back from the provider (return URL, checkout handler).
 *   2. The provider calls your webhook.
 *
 * They arrive in any order, sometimes seconds apart, sometimes both within a millisecond, and the
 * webhook is retried. This server treats both paths identically: verify the signature, call confirm,
 * act on the status. neveroversell guarantees that the units move exactly once no matter what.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://nos:nos@127.0.0.1:54329/nos";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "rzp_test_key_secret";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "rzp_test_webhook_secret";
const STRIPE_ENDPOINT_SECRET = process.env.STRIPE_ENDPOINT_SECRET ?? "whsec_test";

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
export const inventory = createInventory({
  pool,
  holdTtlMs: Number(process.env.HOLD_TTL_MS ?? 10 * 60_000),
  paymentWindowMs: Number(process.env.PAYMENT_WINDOW_MS ?? 30 * 60_000),
});

/** What the application does with each confirm outcome. The library decides the status; you decide the side effect. */
export const fulfilment = {
  fulfilled: [] as string[],
  refunded: [] as Array<{ paymentRef: string; reason: string }>,
  investigate: [] as Array<{ paymentRef: string; holdId: string; otherHoldId: string }>,
};

export function handleConfirm(result: ConfirmResult, holdId: string): { ok: boolean; message: string } {
  switch (result.status) {
    case "confirmed":
      fulfilment.fulfilled.push(holdId);
      return { ok: true, message: "confirmed: fulfil the order" };
    case "already_confirmed":
      return { ok: true, message: "already confirmed by the other path: nothing to do" };
    case "duplicate_payment":
      fulfilment.refunded.push({ paymentRef: result.paymentRef, reason: "second payment for one hold" });
      return { ok: true, message: `duplicate payment ${result.paymentRef}: refund it, keep ${result.existingPaymentRef}` };
    case "payment_ref_in_use":
      fulfilment.investigate.push({ paymentRef: result.paymentRef, holdId, otherHoldId: result.otherHoldId });
      return { ok: false, message: `payment ${result.paymentRef} already bought hold ${result.otherHoldId}: investigate` };
    case "expired":
    case "released":
      fulfilment.refunded.push({ paymentRef: result.paymentRef, reason: `hold was ${result.status} before payment arrived` });
      return { ok: true, message: `hold ${result.status}: refund ${result.paymentRef}` };
    case "not_found":
      return { ok: false, message: "unknown hold" };
  }
}

export function createApp(): express.Express {
  const app = express();

  // Checkout: hold the units, enter the payment phase, hand the client what it needs to pay.
  app.post("/checkout", express.json(), async (req, res) => {
    const { resourceId, qty, accountId, basketId } = req.body as { resourceId: string; qty: number; accountId: string; basketId?: string };
    const held = await inventory.hold({ resourceId, qty, accountId, idempotencyKey: basketId });
    if (held.status !== "held" && held.status !== "replayed") {
      res.status(409).json(held);
      return;
    }
    const paying = await inventory.beginPayment({ holdId: held.hold.id });
    if (paying.status !== "awaiting_payment" && paying.status !== "replayed") {
      res.status(409).json(paying);
      return;
    }
    // In production you would create the provider order here and return its id to the client.
    res.json({ holdId: held.hold.id, orderId: `order_${held.hold.id.slice(0, 8)}`, paymentDeadline: paying.hold.paymentDeadline });
  });

  // Path 1: the browser returns from Razorpay Checkout with order id, payment id and a signature.
  app.get("/return/razorpay", async (req, res) => {
    const { hold, order_id, payment_id, signature } = req.query as Record<string, string>;
    if (!verifyRazorpayCheckout({ orderId: order_id, paymentId: payment_id, signature, keySecret: RAZORPAY_KEY_SECRET })) {
      res.status(400).send("bad signature");
      return;
    }
    const result = await inventory.confirm({ holdId: hold, paymentRef: payment_id });
    const outcome = handleConfirm(result, hold);
    res.status(outcome.ok ? 200 : 409).json({ path: "return", status: result.status, message: outcome.message });
  });

  // Path 2: Razorpay calls the webhook, possibly several times.
  app.post("/webhooks/razorpay", express.raw({ type: "*/*" }), async (req, res) => {
    const signature = req.header("x-razorpay-signature") ?? "";
    if (!verifyRazorpayWebhook({ rawBody: req.body as Buffer, signature, webhookSecret: RAZORPAY_WEBHOOK_SECRET })) {
      res.status(400).send("bad signature");
      return;
    }
    const event = JSON.parse((req.body as Buffer).toString("utf8")) as {
      event: string;
      payload: { payment: { entity: { id: string; notes?: { hold_id?: string } } } };
    };
    if (event.event !== "payment.captured") {
      res.status(200).send("ignored");
      return;
    }
    const holdId = event.payload.payment.entity.notes?.hold_id ?? "";
    const result = await inventory.confirm({ holdId, paymentRef: event.payload.payment.entity.id });
    const outcome = handleConfirm(result, holdId);
    // Always answer 200 once the signature is valid, or the provider keeps retrying a delivery you already handled.
    res.status(200).json({ path: "webhook", status: result.status, message: outcome.message });
  });

  // Path 2, Stripe flavour: payment_intent.succeeded with the hold id in metadata.
  app.post("/webhooks/stripe", express.raw({ type: "*/*" }), async (req, res) => {
    const header = req.header("stripe-signature") ?? "";
    if (!verifyStripeWebhook({ rawBody: req.body as Buffer, header, endpointSecret: STRIPE_ENDPOINT_SECRET })) {
      res.status(400).send("bad signature");
      return;
    }
    const event = JSON.parse((req.body as Buffer).toString("utf8")) as {
      type: string;
      data: { object: { id: string; metadata?: { hold_id?: string } } };
    };
    if (event.type !== "payment_intent.succeeded") {
      res.status(200).send("ignored");
      return;
    }
    const holdId = event.data.object.metadata?.hold_id ?? "";
    const result = await inventory.confirm({ holdId, paymentRef: event.data.object.id });
    const outcome = handleConfirm(result, holdId);
    res.status(200).json({ path: "webhook", status: result.status, message: outcome.message });
  });

  app.get("/resources/:id", async (req, res) => {
    const status = await inventory.status(req.params.id);
    if (!status) {
      res.status(404).end();
      return;
    }
    res.json(status);
  });

  return app;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  await inventory.migrate();
  createApp().listen(port, () => process.stdout.write(`listening on http://127.0.0.1:${port}\n`));
}
