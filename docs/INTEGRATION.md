# Accepting private payments in your app

Three tiers, from zero code to full control. All of it is MIT: copy anything.

## Tier 0: invoice links (zero code)

You need nothing from this repo except a URL. Create an invoice link and put it
wherever your users are: a button, a QR, a chat message.

1. Open the [invoice creator](https://bongbongcrypto.github.io/stealth-checkout/apps/pay-live/index.html).
2. Enter a FRESH receive address (one per invoice: that is what keeps your
   revenue untotalable) and the amount.
3. Optionally fill in your watcher URL and the invoice id you registered it
   under. Do this if you can: without it, the amount lives in the link, and a
   payer who edits the link pays the edited amount and still sees a receipt.
   With it, the payer's page fetches the amount from your server and refuses
   the link if your server does not recognise it or has already settled it.
4. Share the generated link. The payer gets a full checkout: wallet connect,
   private payment from their shielded balance, receipt. If they have not
   shielded yet, the widget tells them what to shield and why, rather than
   depositing for them.

Watch the address yourself, or run the watcher (Tier 2) for webhooks.

**A receipt on the payer's screen is not proof of payment to you.** Without a
watcher, that page is only telling the payer what it observed on-chain. Confirm
independently, from your own ledger, before you ship anything.

## Tier 1: drop-in widget (a few lines)

```bash
npm install strk20-pay
```

If that 404s the package is not published yet; vendor it instead, as below.

A plain git install of this repo does NOT work: npm would fetch the monorepo
root, which exports nothing. If you would rather vendor it than depend on the
registry, copy the package folder and install that (MIT, so the copy is yours):

```bash
git clone --depth 1 https://github.com/bongbongcrypto/stealth-checkout.git /tmp/sc
cp -r /tmp/sc/packages/strk20-pay ./vendor/strk20-pay
npm install ./vendor/strk20-pay
```

### React

The React binding mounts the same widget rather than reimplementing it, so a fix
lands in both at once. It never imports React: you hand it the two hooks it
needs, which keeps `strk20-pay` installable in projects that have no React.

```tsx
import { useEffect, useRef } from "react";
import { createCheckoutHook } from "strk20-pay/react";

const useCheckout = createCheckoutHook({ useEffect, useRef });

export function PayButton({ invoice, wallet }) {
  const ref = useCheckout({
    invoice,
    wallet,
    confirm: (inv) => fetch(`/api/confirm/${inv.id}`).then((r) => r.ok),
    onPaid: (receipt) => console.log(receipt),
  });
  return <div ref={ref} />;
}
```

Inline callbacks are read through a ref, so a parent re-render cannot tear down
a checkout that is mid-payment. The widget remounts only when the invoice's own
terms change.

```ts
import { mountCheckout, WalletApiAdapter } from "strk20-pay";

mountCheckout(document.getElementById("pay")!, {
  invoice: {
    id: "order-42",
    token: "STRK",
    amount: "5",
    memo: "Pro plan, one month",
    mode: "address",
    receiveAddress: FRESH_ADDRESS_FOR_THIS_INVOICE,
    network: "mainnet",
    createdAt: Date.now(),
  },
  wallet: new WalletApiAdapter({ network: "mainnet" }),
  // REQUIRED IF ANYTHING OF VALUE DEPENDS ON THIS. Without `confirm`, the
  // default is `async () => true`: the widget believes the payer and calls
  // onPaid without checking the chain. Point it at your own backend (Tier 2)
  // or a balance check you control.
  // MUST resolve to a boolean. `r.json()` resolves to an OBJECT, and every
  // object is truthy, so `{"paid": false}` would ship the goods.
  confirm: (invoice, txHash) => fetch(`/api/paid?id=${invoice.id}`).then((r) => r.json()).then((b) => b.paid === true),
  onPaid(receipt) {
    // unlock the thing they paid for
  },
});
```

> The widget refuses to pay when `wallet.network` and `invoice.network` differ,
> and the receipt always reports the wallet's network, never the invoice's
> claim. A testnet payment can never mint a mainnet-looking receipt.

That renders the button, the progress line, the pre-sign honesty panel, and the
receipt. No React required; a React wrapper is a `useEffect` around this call.

Buildless page? The core and UI import cleanly from our Pages host:

```html
<script type="module">
  import { mountCheckout, MockWallet } from
    "https://bongbongcrypto.github.io/stealth-checkout/packages/strk20-pay/dist/index.js";
  // MockWallet lets you develop the full flow with no extension and no funds.
</script>
```

(The real `WalletApiAdapter` pulls `starknet` at runtime, so that one needs a
bundler; see `apps/pay-live/main.ts` for the exact wiring we ship.)

## Tier 2: headless confirmation + webhooks (merchant backend)

The watcher confirms payments without proving services or discovery endpoints:
it polls `balanceOf` on each invoice's fresh address over plain JSON-RPC, then
fires an HMAC-signed webhook.

```bash
WEBHOOK_URL=https://your.app/hooks/spay \
WEBHOOK_SECRET=whsec_yours \
node server/watcher/watcher.mjs
```

`WATCHER_TOKEN` is required: without it every merchant route refuses rather
than starting open. Set `WATCHER_ORIGIN` to the exact origin of your dashboard
if a browser needs to reach it; that grant is an exact origin, never a wildcard.

Two routes are deliberately outside the token, because the people who need them
have no token:

- `GET /healthz` returns `{ok:true}` and nothing else.
- `GET /public/invoices/:id?to=0x…` returns one invoice's terms, and only to a
  caller who presents both its id **and** its receive address, which is exactly
  what a payment link carries. It is readable from any origin
  (`Access-Control-Allow-Origin: *`) because a payer's page is not your
  dashboard; it carries no credentials, so that grant gives a script nothing a
  plain `fetch` could not already have. It never returns baselines, webhook
  state, or anything else from your ledger.

Bind the watcher to loopback and put your own proxy in front if that is not the
trade you want.

```bash
# register an invoice to watch
curl -X POST http://127.0.0.1:8787/invoices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WATCHER_TOKEN" \
  -H "Idempotency-Key: order-42-create" \
  -d '{"id":"order-42","token":"STRK","amount":"5","receiveAddress":"0x...","expiresAt":1756600000000}'
```

Send `Idempotency-Key` on every create. A POST that times out on your side has
usually succeeded on the server's, and retrying without a key returns "invoice
already exists", which reads like a failure and gets retried by hand. With a
key, the retry returns the invoice that was created the first time.

Your endpoint receives:

```json
{ "event": "payment.confirmed",
  "deliveryId": "dlv_4f3c…",
  "attempt": 1,
  "invoice": { "id": "order-42", "token": "STRK", "amount": "5", "status": "paid",
               "receiveAddress": "0x04ea…", "txHash": "0x30ec…",
               "receivedUnits": "5000000000000000000", "shortfallUnits": null,
               "overpaidUnits": null, "confirmedAt": 1756600000000 } }
```

### Invoice states

| State | Meaning | What to do |
|---|---|---|
| `watching` | Live, accepting payment. `receivedUnits` shows partial progress. | Nothing. |
| `paid` | Settled in full, before the deadline. | Ship it. |
| `paid_late` | Settled in full, after the deadline but inside a 24-hour grace window. | Your policy. The money is real either way. |
| `underpaid` | The deadline passed with some money at the address, but not enough. `shortfallUnits` says how much is missing. | Refund or top up by hand. The address is deliberately not released. |
| `expired` | The deadline passed with nothing received. | Nothing. Deletable. |
| `reserving` | A create crashed mid-flight. | Delete it and create again. |
| `needs_reregistration` | A row from a build that predates baselines. | Delete it and create again. |

An `overpaidUnits` field appears on any settled invoice that received more than
it asked for. Nothing is done with it automatically: silently keeping an
overpayment is how disputes start.

**Do not sweep an address while its invoice is still being watched.**
Confirmation reads a balance and compares it to a baseline, so it cannot see
money that has already been moved out. Sweeping early under-credits the payer,
and the watcher logs a warning when it notices. Sweep after the invoice reaches
`paid`, `paid_late`, or a resolved `underpaid`.

### Webhook delivery

Deliveries are queued on the invoice row itself and persisted, so a restart
resumes them rather than losing them. Failures back off exponentially up to
thirty minutes and stop after eight attempts, at which point:

```bash
curl -X POST http://127.0.0.1:8787/invoices/order-42/redeliver \
  -H "Authorization: Bearer $WATCHER_TOKEN"
```

re-queues the same `deliveryId`.

### Reconciliation

```bash
curl http://127.0.0.1:8787/invoices.csv -H "Authorization: Bearer $WATCHER_TOKEN" -o invoices.csv
```

or use the dashboard's **Export CSV** button. Timestamps are ISO-8601 and cells
beginning `=`, `+`, `-`, or `@` are prefixed with an apostrophe, so opening the
file in a spreadsheet cannot execute anything.

`txHash` is best effort and may be `null`; the confirmation itself rests on the
balance delta, so never require the hash to be present.

Verify with `verifySignature(secret, rawBody, signature, timestamp)` from
`server/watcher/lib.mjs`. It returns false for an empty secret, so a missing
env var fails closed rather than accepting anything. The signature covers `timestamp.body`, sent in
`X-Spay-Signature` and `X-Spay-Timestamp`, and anything older than five minutes
is rejected, so a captured delivery cannot be replayed later. Retries reuse the
same `deliveryId`: dedupe on it.

Sanity-check the whole thing before wiring it up: `npm run e2e:watcher` reads
mainnet, asserts that a heavily funded address is NOT treated as paid, and
exercises the signed webhook including replay rejection. It spends nothing.

## Why the widget will not shield for your payer

If the payer has no shielded balance, the widget stops and tells them to shield in
their wallet first, ahead of time. That refusal is deliberate, and it comes from the
protocol's own guidance: a deposit is a public leg that names the depositor, so a
deposit made moments before a payment can be tied to it by amount and timing.
Shielding separately, earlier, is what makes the payment unlinkable. It is also
cheaper, because the pool charges a fee per deposit.

Pass `allowInlineShield: true` if you would rather trade that away for a single
click; our arcade demo does, because a mock wallet has no wallet UI to send players to.

## Budget for the pool's fee

The pool charges a **flat 6 STRK per operation** on mainnet, on top of the
amount, read live from `get_fee_amount()`. It is the same whether the operation
moves 1 STRK or 1,000, and it is charged once per operation: a payer who has to
shield first pays it twice.

The consequences are worth pricing in before you launch:

- The widget adds it to the total the payer sees, and warns when it exceeds the
  invoice. Do not build your own total from `invoice.amount` alone.
- Below roughly 60 STRK, the fee is more than 10% of the purchase. Micropayments
  through the pool do not work today, whatever the UI makes them look like.
- `wallet.poolFee(token)` returns it, or `null` when it cannot be read. Treat
  `null` as unknown, never as zero.

## Upgrading from an earlier build

Invoices written before this version carry no baseline, and a baseline is what
makes confirmation safe. The watcher will not resume them: they come back as
`needs_reregistration` and are logged at startup. Re-register each open invoice
against the same address, and the current balance becomes its baseline.

## The honesty contract

Whatever tier you use, tell your users the truth. With STRK20 today:

| Public on-chain | Hidden |
|---|---|
| Deposits into the pool: depositor, token, amount (compliance-screened) | Note-to-note transfers: amounts and both parties |
| An unshield's destination address and amount | Which deposit funded it, and the payer's wallet |
| Timing of pool interactions | A merchant's revenue, to anyone watching one invoice address |

Two limits on that last row, because it is easy to overclaim:

- Sweeping several invoice addresses into one treasury links them on-chain, and
  the total becomes visible after all. Shield the proceeds instead if that
  matters.
- Your own invoice ledger knows everything. Keep the watcher's API token secret
  and its origin allowlist tight.

A distinctive amount paid right after a distinctive deposit is correlatable.
Advise payers to shield ahead of time, and more than they spend. The widget's
pre-sign panel says all of this automatically.

One more path the on-chain view does not cover: the hosted page confirms by
polling a public RPC from the payer's browser, so that RPC operator can see one
IP watching one invoice address. Self-host the RPC, or use the watcher, if that
is in your threat model.

## Getting funds out (merchant side)

**This part is yours to build, and it is not small.** Each invoice needs its own
fresh Starknet account, and this repo ships no key management: no derivation, no
keystore, no deployment, no sweeper. What a real merchant needs:

1. Derive a keypair per invoice from one seed you keep offline.
2. Compute the counterfactual account address, and hand that to the invoice. It
   does not need deploying to receive an ERC-20.
3. To move the funds, deploy the account (it needs a little STRK for its own
   deploy fee) and transfer out. Budget that fee per invoice.
4. Note that a sweep to one treasury address links those invoice addresses
   together on-chain. Shielding the proceeds instead keeps them apart.

Until you have that, use the hosted links (Tier 0) with addresses you generate
by hand.

Questions? Open an issue, or find us in the sprint Telegram (@bongbongcrypto).
