# 3-minute demo video: shot list

Judges watch this before they read anything. Three minutes, four beats, one real
mainnet payment on camera.

**Record at 1280x800.** Screen capture only, no webcam. Narrate live or add captions
afterwards; the script below is what to say, roughly, not word for word.

## Before you hit record

1. **Shield ahead of time.** In Ready X, shield **20 STRK**. The pool charges a flat
   6 STRK per operation, so shield in one chunk, never in fives. Wait for the wallet to
   show the new Shielded Starknet balance (about ten blocks).
   This also matches what the widget tells payers to do, so the video stays consistent.
2. Close every tab except the ones below. Zoom the browser to 110% so text reads on a
   phone.
3. Have these open as tabs, in order:
   - `https://bongbongcrypto.github.io/stealth-checkout/` (the landing page)
   - `https://bongbongcrypto.github.io/stealth-checkout/apps/demo-arcade/index.html`
   - the invoice link (below)
   - `https://voyager.online/`
   - `https://github.com/bongbongcrypto/stealth-checkout`
4. Start the watcher in a terminal you can show:
   `WATCHER_TOKEN=demo node server/watcher/watcher.mjs`, and open the dashboard with
   that token pasted in. Register the invoice below through the dashboard so the
   payer page can read its terms from the server on camera.

**Invoice link for the live payment** (pays account 2, so money moves to a different
address on camera):

```
https://bongbongcrypto.github.io/stealth-checkout/apps/pay-live/index.html?to=0x055b3434802D52dD37f0A29E04Eb1c497b8998c3360B7A0319f81E5e165C4FC3&amount=5&memo=Order%20%2342&id=demo-live
```

Cost of the take: 5 STRK paid plus 6 STRK pool fee, out of what you shielded.

If the watcher is reachable from the public page, append
`&watcher=https://<your tunnel>` so the amount comes from the server on camera. If it
is not, drop the parameter: the page then says plainly that its receipt is a payer-side
observation, which is worth showing too.

---

## 0:00 to 0:25 - the gap

*Screen: the repo README, scrolled to "Why".*

> STRK20 brought private balances to Starknet, and the ecosystem filled up fast with
> ways to **send** money privately. Claim links, red packets, payroll.
> Nobody built the other half. If you run a store or an app and want to **accept** a
> private payment, there is nothing to install. No checkout, no invoices, no receipts,
> and no way for your backend to find out you got paid.
> Stealth Checkout is that half.

## 0:25 to 1:10 - it works, with zero setup

*Screen: the arcade demo. Click INSERT COIN, then the pay button.*

> Here is a merchant. This arcade sells game credits, and the panel on the right is the
> entire widget, the same one any Starknet app can embed.
> Watch the flow: it checks the shielded balance, pays the invoice privately, the
> arcade's backend confirms it, and a credit lands.

*Before clicking pay, point at the confirmation block and the amber warning.*

> Look at this before anything is signed. The invoice is one STRK. The payer pays
> seven, because the pool charges a **flat six STRK per operation**, whatever the
> amount, and that number is documented nowhere in STRK20's docs. We found it by
> calling the contract and by making the arithmetic on our own seven mainnet
> transactions balance.
> So the widget reads it live, adds it to the total, and warns you when the fee is
> bigger than the thing you are buying. Which on a one-STRK coin it is.
> That is a real constraint on what private payments can be used for today, and a
> checkout that showed a price and hid it would be lying.

*Let the phases play. Point at the progress line.*

> Every wait says what it is waiting for, right next to the button that caused it, and
> the wallet popup is announced before it appears.

*Point at the honesty panel, already open.*

> And it is open by default, because a disclosure collapsed under the pay button is not
> a disclosure. Amber is what goes on-chain, green is what stays hidden. No privacy
> overclaiming.

*Click START and play for five seconds.*

> This runs on a mock wallet, so anyone can try the whole thing with no extension and
> no funds. Now the real one.

## 1:10 to 2:10 - a real payment on mainnet

*Screen: the invoice link. Point at the green wallet check.*

> A hosted invoice, on Starknet mainnet. The widget checks the wallet can actually make
> private payments before offering the button.

*Click pay. Approve in Ready X. Wait for the receipt.*

> One prompt. The payment leaves my shielded balance and lands on a fresh address made
> for this invoice.
> Notice what it did not do: it did not offer to shield for me. A deposit is public and
> names the depositor, so shielding right before paying is exactly what lets someone
> tie the two ends together. The widget makes you shield ahead of time instead, and
> says why.

*Receipt appears. Copy the payment tx hash into Voyager.*

> Here is the receipt with both hashes, and here is the transaction on Voyager.
> Succeeded, against the pool. The sender is a relayer, not me: that is the pool
> severing my identity from the payment.

## 2:10 to 2:40 - the merchant side

*Screen: terminal running `node server/watcher/watcher.mjs`, then the dashboard.*

> Merchants need to know they got paid without opening a wallet. This watcher polls the
> invoice address over plain public RPC and fires a signed webhook.
> No proving service, no discovery endpoint, no infrastructure that is not published
> yet. That is the whole trick that makes accepting payments work today.

*Dashboard: create an invoice, show it flip to PAID, then hit Export CSV.*

> Create an invoice, watch it confirm, copy the pay link, export the ledger. That is
> the merchant loop.

*Point at the UNDERPAID row.*

> And the states are the ones a real merchant needs. A partial payment is not
> "expired", it is underpaid, with the shortfall, and its address stays reserved so a
> later invoice cannot settle on the money sitting there. A payment that lands after
> the deadline is paid late, not lost. Deliveries survive a restart, and there is a
> redeliver endpoint for when your endpoint was the thing that was down.

## 2:40 to 3:00 - take it

*Screen: docs/INTEGRATION.md, then `npm install strk20-pay`.*

> Three ways in. An invoice link with zero code. The widget in one mount call, vanilla
> or React. Or the watcher with webhooks if you want your own backend.
> It is MIT. If your sprint project needs to get paid, this is the layer, and I will
> fix whatever breaks the same day.

*Only say "it is on npm" if `npm publish` has actually run by the time you record.*
> Repo is in the description.

---

## After recording

1. Upload unlisted to YouTube.
2. Put the URL in `strk20.json` as `demo_video`, commit, push.
3. Add the new payment hash to `transactions` in the same commit.
4. Verify on chain, then confirm the hub row updates (it reads the repo every 30 min).
