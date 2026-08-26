# Stealth Checkout

**Accept private payments on Starknet.** A drop-in checkout for STRK20: an embeddable payment widget, hosted invoice links, headless confirmation with signed webhooks, receipts, and a pre-sign panel that tells the payer exactly what the payment does and does not reveal.

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon).

**Try it now:**
[coin-op arcade demo](https://bongbongcrypto.github.io/stealth-checkout/apps/demo-arcade/index.html) (full flow on a mock wallet, no setup) ·
[hosted invoice page](https://bongbongcrypto.github.io/stealth-checkout/apps/pay-live/index.html) (real wallet, mainnet) ·
[merchant dashboard](https://bongbongcrypto.github.io/stealth-checkout/apps/dashboard/index.html) ·
[integration guide](docs/INTEGRATION.md)

```bash
npm install strk20-pay   # once published: see Status below
```

## Why

STRK20 gives Starknet shielded balances and private transfers. The ecosystem around it is growing fast on the **sending** side: claim links, red packets, payroll rails. But if you run a storefront, a dapp, or a DAO and want to **accept** a private payment, there is nothing to install: no checkout component, no invoices, no receipts, and no way for your backend to learn "you got paid" without opening a wallet and looking.

Stealth Checkout is that missing accepting side.

## What's in the box

| Piece | What it does |
|---|---|
| [`strk20-pay`](packages/strk20-pay) | Framework-agnostic TS widget, plus a React binding. One call renders the whole flow: connect → check balance → pay → confirmed → receipt. It refuses to shield for the payer by default, and says why. |
| Hosted invoice page | `apps/pay-live/?to=0x…&amount=25&id=…` — a shareable payment link, with a QR beside it. Served from the same origin as your watcher, it reads the amount from your server and refuses to take a payment for an invoice that server has already settled or never heard of. Served from anywhere else - including the copy on GitHub Pages - it renders a payable checkout behind a plain warning that the amount and destination came from the link and nothing has checked them. A link cannot nominate its own auditor. |
| Watcher + webhooks | Confirms payments by watching per-invoice receive addresses over public RPC. No proving dependency, fully headless. Signed webhooks with a persisted retry queue. |
| Merchant dashboard | Create invoices, watch them settle, release stuck rows, export the ledger as CSV. |
| QR codes | **Dynamic**: one code per invoice, price baked in, shown next to the link and on every dashboard row. **Static**: a counter code printed once, where the payer enters the amount. Encoder written in-repo, no dependency. |
| Honesty panel | Before signing, what this payment reveals on-chain and what it hides. Open by default. |
| Demo arcade | A coin-op arcade that sells credits through the widget. The full loop in about two minutes, with nothing installed. |

## Three findings worth more than the code

**1. The pool charges a flat 6 STRK per operation, and documents it nowhere.**
Not a percentage: the same 6 STRK whether you move 1 STRK or 1,000. It is read live from the pool's `get_fee_amount()`. A checkout that shows a price and hides that is lying by omission, so the widget adds it to the total before the payer signs, and warns when it is larger than the invoice. It also means private payments have an economic floor: below roughly 60 STRK, the fee is more than 10% of the purchase.

**2. Confirmation must be a delta, never a balance.**
Invoice addresses can already hold funds — they need STRK to deploy before a merchant can sweep them, merchants reuse addresses by mistake, and airdrops happen. Confirming on the absolute balance marks such an invoice paid the moment it is created. The watcher captures a baseline at registration and confirms only on growth, and refuses to judge any row whose baseline is missing.

**3. A static QR publishes the shop's takings, and only the shop's.**
A counter code is one printed square that every customer scans, which means one
receiving address forever. The payer stays private either way: the pool severs
who sent each payment. The merchant does not, because anyone can add up what
that address has taken and count the payments that made it up. The choice is
real and it is theirs, so the link creator states the cost in the sentence
where the choice is made, rather than in a footnote nobody opens.

## Design constraints honoured

- **Composes only shipped wallet actions** (shield, private transfer and unshield via the Privacy Wallet API; its fourth action, swap, is not used here). Nothing in the core loop depends on unpublished mainnet infrastructure.
- **Honest privacy accounting.** Deposits into the pool are public and compliance-screened. Note-to-note transfers hide amounts and parties. An unshield shows destination and amount, while the payer's identity stays severed by the pool. The widget says exactly this, every time, before signing.
- **Pending states are first-class.** Pool notes take about 10 blocks to mature; every wait is shown next to the button that caused it, and wallet popups are announced before they appear.
- **Money is never dropped on a technicality.** A partial payment becomes `underpaid`, not `expired`. A payment that lands after the deadline becomes `paid_late`, not lost. An address is never released for reuse once anything has arrived on it.

## Payment modes

1. **Invoice address (default)**: the payer unshields to a fresh per-invoice address. The merchant confirms headlessly over public RPC and fires a webhook. Payer identity: severed by the pool. Amount and invoice address: visible.
2. **Note transfer**: the payer sends a private note to the merchant's pool account. Fully private on-chain; confirmation happens wallet-side, because note discovery is not available on mainnet.

## Run it locally

```bash
npm install
npm test                 # 205 tests: widget, checkout core, QR encoder, watcher logic, HTTP API
npm run build:all        # widget dist + hosted-page bundle
npm run dev              # demos at http://127.0.0.1:4173
WATCHER_TOKEN=dev node server/watcher/watcher.mjs
```

Two checks run in a browser rather than in Node, because what they measure only
exists once something has been drawn:

- `packages/strk20-pay/test/layout-check.html` loads all seven screens at a
  laptop size and a phone size and measures each one against seven rules. It
  exists because the pay button on the arcade demo sat 699px below the fold on a
  laptop and 1298 on a phone, and three rounds of clicking through the flow never
  noticed: whoever clicks already knows where the button is. Run it against the
  [deployed copy](https://bongbongcrypto.github.io/stealth-checkout/packages/strk20-pay/test/layout-check.html)
  as well as a dev server; a 13px link in the dashboard showed up only there,
  because the local server filled the table faster than the check looked at it.
- `packages/strk20-pay/test/qr-scan.html` renders every QR through the browser
  and reads the pixels back, which is the only way to catch a wrong viewBox, a
  missing quiet zone, or an inverted palette.

`npm run e2e:watcher` runs against mainnet without spending anything. It proves the watcher reads a real balance over public RPC, captures a baseline, and **refuses to confirm an address that merely holds funds**, then sends one signed webhook and checks the signature verifies, that a replayed timestamp does not, and that the delivery was recorded on the invoice row.

It deliberately does not prove a real payment was detected: that needs someone to actually pay, and this script will not do that with your money. It also does not restart the process, so it does not prove the delivery queue survives one; the unit suite covers that.

## Repository layout

```
index.html             # landing page, linking the three apps
packages/strk20-pay/   # the embeddable checkout (core, adapters, React binding, honesty report, QR encoder)
apps/demo-arcade/      # coin-op arcade demo store
apps/pay-live/         # hosted invoice page (link creator + payer view)
apps/dashboard/        # merchant dashboard
server/watcher/        # RPC watcher, webhook dispatcher, invoice ledger
server/dev-static.mjs  # no-cache static server for local demos
docs/                  # integration guide, video script, announcement
strk20.json            # sprint manifest (txs, demo, video)
```

## Verified on mainnet

`strk20.json` lists seven Starknet mainnet transactions against the live STRK20 pool. Every one exists, SUCCEEDED, and reached L1.

| Block | What it is | Tx |
|---|---|---|
| 13642789 | `ViewingKeySet` + `Deposit`: the one-time pool registration, then the opening shield | `0x30ecaffb...9b32` |
| 13643191 | `Withdrawal`: 5 STRK out of the pool to a chosen destination | `0x32a6b74f...0140` |
| 13643247 | `Deposit` | `0x620188e2...bed3` |
| 13643266 | `Deposit` | `0x365816d7...bdf1` |
| 13645507 | `Deposit` | `0x1663fa3f...700b` |
| 13645574 | `Withdrawal`: 5 STRK out of the pool to a chosen destination | `0x683df5a6...2c14` |
| 13645946 | `Deposit` | `0x5a054090...629d` |

**What these do and do not show.** The two withdrawals exercise the exact
operation an invoice payment uses: shielded funds leaving the pool to a
destination address. Each transaction's `sender_address` is a different
address, and none of them is the pool account that owns the funds: nobody
reading the chain learns who asked for the withdrawal. That is the pool
severing the payer's identity, and it is real. (Inside the transaction the STRK
transfer is emitted by the pool contract, as it must be; the identity that is
hidden is the one that submitted it.)

They are **not** end-to-end payments to a merchant. Both sent their 5 STRK to
`0x4ea15bf3…`, the same address that made all five deposits, because they were
run as tests of the mechanism with the only funds available. A payment to a
fresh per-invoice address is the same operation with a different destination
felt, but this table would be overclaiming if it said one had happened.

The ledger balances exactly, and this is where the pool's undocumented fee was
found: 55 STRK deposited, 10 withdrawn, 42 taken as a flat 6 STRK on each of
the seven operations, leaving 3 STRK shielded. The direction matters and is not
obvious: the fee comes **out of** a deposit and **on top of** a withdrawal, so
`20-6, -5-6, +5-6, +5-6, +20-6, -5-6, +5-6 = 3`.

No contracts were deployed, so these are judged against the pool alone.

## Status

- [x] Public repo, MIT licensed
- [x] Live demo URL
- [x] 3+ mainnet transactions against the STRK20 pool in `strk20.json`
- [ ] 3-minute demo video
- [ ] `strk20-pay` published to npm (packaged and ready; publishing is the owner's to run)

## License

MIT
