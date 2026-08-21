# Stealth Checkout

**Accept private payments on Starknet.** A drop-in checkout for STRK20: embeddable payment widget, hosted invoice pages, headless payment confirmation with webhooks, receipts, and a pre-sign panel that tells the payer exactly what the payment does and does not reveal.

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon).

**Try it now:**
[coin-op arcade demo](https://bongbongcrypto.github.io/stealth-checkout/apps/demo-arcade/index.html) (full flow on a mock wallet, no setup) ·
[invoice creator / hosted checkout](https://bongbongcrypto.github.io/stealth-checkout/apps/pay-live/index.html) (real wallet, mainnet) ·
[integration guide](docs/INTEGRATION.md) (three tiers, from zero code to webhooks)

## Why

STRK20 gives Starknet shielded balances and private transfers. The ecosystem around it is growing fast on the **sending** side: claim links, red packets, payroll rails. But if you run a storefront, a dapp, or a DAO and want to **accept** a private payment, there is nothing to install: no checkout component, no invoices, no receipts, and no way for your backend to learn "you got paid" without opening a wallet and scanning.

Stealth Checkout is that missing accepting side: the Stripe Checkout of private payments.

## What's in the box

| Piece | What it does |
|---|---|
| `strk20-pay` | Framework-agnostic TS widget + React wrapper. One import → "Pay privately" button with full flow UX (connect → shield if needed → pay → confirmed). |
| Hosted invoice pages | Sharable `pay/<invoice-id>` pages with amount, memo, status: like a payment link, but the payer side stays private. |
| Watcher + webhooks | Merchant backend confirms payments by watching public RPC for per-invoice receive addresses. No proving dependency, fully headless. Fires `payment.confirmed` webhooks. |
| Receipts | Per-payment receipt the payer can keep and selectively show: "this invoice was paid" without exposing their wallet history. |
| Honesty panel | Before signing, the widget shows what this payment reveals on-chain and what it hides. No privacy overclaiming, ever. |
| Demo store | A coin-op arcade: insert a coin (1 STRK, privately) → play. The full loop, experienceable solo in ~2 minutes. |

## Design constraints we honor

- **Composes only shipped wallet actions** (shield / private transfer / unshield / swap via the Privacy Wallet API). Nothing in the core loop depends on unpublished mainnet infrastructure.
- **Honest privacy accounting.** Deposits into the pool are public and compliance-screened. Note-to-note transfers hide amounts and parties. An unshield shows destination and amount, while the payer's identity stays severed by the pool. The widget says exactly this to the payer, every time.
- **Pending states are first-class.** Pool notes take ~10 blocks to mature; every wait is shown next to the button that caused it, with the wallet popup announced before it appears.

## Payment modes

1. **Invoice address (default)**: the payer unshields to a fresh per-invoice address. The merchant backend confirms it headlessly over public RPC and fires a webhook. Payer identity: severed by the pool. Amount + invoice address: visible (that's the receipt working for you).
2. **Note transfer**: the payer sends a private note to the merchant's pool account. Fully private on-chain; confirmation happens wallet-side.

## Repository layout

```
packages/strk20-pay/   # the embeddable checkout (core + adapters + honesty report)
apps/demo-arcade/      # coin-op arcade demo store
apps/dashboard/        # merchant dashboard (invoices, payments, receipts)
server/watcher/        # RPC watcher + webhook dispatcher
strk20.json            # sprint manifest (txs, demo, video)
```

## Verified on mainnet

`strk20.json` lists five Starknet mainnet transactions against the live STRK20 pool.
All of them exist, SUCCEEDED, and carry pool events for the same account:

| Block | What it is | Tx |
|---|---|---|
| 13642789 | `ViewingKeySet` + `Deposit`: the one-time pool registration, then the opening shield | `0x30ecaffb...9b32` |
| 13643247 | `Deposit` | `0x620188e2...bed3` |
| 13643266 | `Deposit` | `0x365816d7...bdf1` |
| 13645507 | `Deposit` | `0x1663fa3f...700b` |
| 13643191 | pool state event | `0x32a6b74f...0140` |

Re-verify any of them yourself, and prove the headless confirmation path at the same
time, with `npm run e2e:watcher`: it confirms a payment against mainnet over public RPC
and fires a signed webhook, without spending anything.

## Status

Sprint build in progress (Aug 14 to 31). Scored checklist:

- [x] Public repo, MIT licensed
- [x] Live demo URL
- [x] 3+ mainnet transactions against the STRK20 pool in `strk20.json`
- [ ] 3-minute demo video

## License

MIT
