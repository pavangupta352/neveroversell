# Two confirmation paths, one hold

Every hosted checkout gives you two ways to learn that a payment succeeded: the browser comes back to your return URL, and the provider calls your webhook. They arrive in any order, sometimes at the same instant, and the webhook is retried. Fulfilling twice, refunding nothing, or reviving an expired hold are the three classic bugs. This example shows all of them not happening.

## Run it

From the repository root:

```sh
npm install && npm run build
npm run db:up
cd examples/two-paths-express
npm install
npm run simulate
```

`simulate.ts` starts the server in-process, plays the provider with valid signatures, and prints what each path got back for four scenarios: return first then webhook, both at the same instant with retries, a customer who paid twice, and a webhook that arrives after the hold expired.

To run the server on its own: `npm start`, then point your provider's test webhooks at it.

## What to read

- `server.ts`: three routes that all do the same thing: verify the signature, call `confirm`, act on the status.
- `provider.ts`: the signature checks for Razorpay Checkout, Razorpay webhooks and Stripe webhooks, written out in full.
- `handleConfirm` in `server.ts`: the whole business policy, one case per status.

The secrets default to test values; set `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and `STRIPE_ENDPOINT_SECRET` for real ones.
