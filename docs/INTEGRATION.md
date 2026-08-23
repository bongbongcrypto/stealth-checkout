# Accepting private payments in your app

Three tiers, from zero code to full control. All of it is MIT: copy anything.

## Tier 0: invoice links (zero code)

You need nothing from this repo except a URL. Create an invoice link and put it
wherever your users are: a button, a QR, a chat message.

1. Open the [invoice creator](https://bongbongcrypto.github.io/stealth-checkout/apps/pay-live/index.html).
2. Enter a FRESH receive address (one per invoice: that is what keeps your
   revenue untotalable) and the amount.
3. Share the generated link. The payer gets a full checkout: wallet connect,
   shield if needed, private payment, receipt. Confirmation runs in the payer's
   browser over public RPC.

Watch the address yourself, or run the watcher (Tier 2) for webhooks.

## Tier 1: drop-in widget (a few lines)

The widget is plain ESM. It is not on npm yet, and a plain git install does NOT
work: npm would fetch the monorepo root, which exports nothing. Vendor the
package folder instead. Two commands, and you own the copy (MIT):

```bash
git clone --depth 1 https://github.com/bongbongcrypto/stealth-checkout.git /tmp/sc
cp -r /tmp/sc/packages/strk20-pay ./vendor/strk20-pay
npm install ./vendor/strk20-pay
```

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
  confirm: (invoice, txHash) => fetch(`/api/paid?id=${invoice.id}`).then((r) => r.json()),
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

```bash
# register an invoice to watch
curl -X POST http://127.0.0.1:8787/invoices \
  -H "Content-Type: application/json" \
  -d '{"id":"order-42","token":"STRK","amount":"5","receiveAddress":"0x..."}'
```

Your endpoint receives:

```json
{ "event": "payment.confirmed",
  "deliveryId": "dlv_4f3c…",
  "invoice": { "id": "order-42", "token": "STRK", "amount": "5",
               "receiveAddress": "0x04ea…", "txHash": "0x30ec…", "receivedUnits": "5000000000000000000",
               "confirmedAt": 1756600000000 } }
```

`txHash` is best effort and may be `null`; the confirmation itself rests on the
balance delta, so never require the hash to be present.

Verify with `verifySignature(secret, rawBody, signature, timestamp)` from
`server/watcher/lib.mjs`. The signature covers `timestamp.body`, sent in
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
