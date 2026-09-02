import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signature checks for the two providers used in this example, written out so you can see exactly
 * what is being verified. In production use the provider's SDK if you prefer; the reservation logic
 * does not change either way.
 */

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Razorpay Checkout success handler: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyRazorpayCheckout(input: { orderId: string; paymentId: string; signature: string; keySecret: string }): boolean {
  const expected = createHmac("sha256", input.keySecret).update(`${input.orderId}|${input.paymentId}`).digest("hex");
  return safeEqualHex(expected, input.signature);
}

/** Razorpay webhook: X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook secret). */
export function verifyRazorpayWebhook(input: { rawBody: Buffer; signature: string; webhookSecret: string }): boolean {
  const expected = createHmac("sha256", input.webhookSecret).update(input.rawBody).digest("hex");
  return safeEqualHex(expected, input.signature);
}

/** Stripe webhook: Stripe-Signature header "t=<ts>,v1=<HMAC_SHA256(ts + "." + raw body, endpoint secret)>". */
export function verifyStripeWebhook(input: { rawBody: Buffer; header: string; endpointSecret: string; toleranceSeconds?: number; now?: number }): boolean {
  const parts = Object.fromEntries(
    input.header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > tolerance) return false;
  const expected = createHmac("sha256", input.endpointSecret).update(`${t}.${input.rawBody.toString("utf8")}`).digest("hex");
  return safeEqualHex(expected, v1);
}

/** Helpers the simulator uses to produce valid signatures, exactly as the providers would. */
export const sign = {
  razorpayCheckout(orderId: string, paymentId: string, keySecret: string): string {
    return createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  },
  razorpayWebhook(rawBody: string, webhookSecret: string): string {
    return createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  },
  stripeWebhook(rawBody: string, endpointSecret: string, now = Math.floor(Date.now() / 1000)): string {
    const v1 = createHmac("sha256", endpointSecret).update(`${now}.${rawBody}`).digest("hex");
    return `t=${now},v1=${v1}`;
  },
};
