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

The widget is plain ESM. If you bundle your app (Vite, Next, esbuild), install
from git and mount it:

```bash
npm install "git+https://github.com/bongbongcrypto/stealth-checkout.git#main"
# the package lives at packages/strk20-pay; or simply copy that folder (MIT)
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
  onPaid(receipt) {
    // unlock the thing they paid for
  },
});
```

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
  "invoice": { "id": "order-42", "token": "STRK", "amount": "5",
               "receiveAddress": "0x...", "txHash": "0x...", "confirmedAt": 1756600000000 } }
```

Verify the `X-Spay-Signature` header with HMAC-SHA256 over the raw body
(`verifySignature` in `server/watcher/lib.mjs` is the reference).

Prove it works before wiring anything: `npm run e2e:watcher` runs the whole
confirm-and-webhook loop against Starknet mainnet without spending anything.

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
| Timing of pool interactions | The merchant's total revenue (fresh address per invoice) |

A distinctive amount paid right after a distinctive deposit is correlatable.
Advise payers to shield ahead of time, or more than they spend. The widget's
pre-sign panel says all of this automatically.

## Getting funds out (merchant side)

Each paid invoice leaves funds on its own fresh address. Sweep them on your own
schedule; consider shielding them again if you want your treasury private. Fresh
addresses are just Starknet accounts: generate a keypair per invoice and deploy
lazily, or use subaddresses of an account you already control.

Questions? Open an issue, or find us in the sprint Telegram (@bongbongcrypto).
