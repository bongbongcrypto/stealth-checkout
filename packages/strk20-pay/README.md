# strk20-pay

Drop-in checkout for **accepting** private payments on Starknet.

STRK20 gives wallets a way to send money privately. This gives applications a way to get paid that
way: an embeddable widget, one receive address per invoice, receipts, and confirmation over public
JSON-RPC with no proving service in the loop.

```bash
npm install strk20-pay
```

If that 404s, the package has not been published yet: clone the repo and
`npm install ./packages/strk20-pay` instead. It is MIT, so the copy is yours.

Requires a wallet advertising Privacy Wallet API `0.10.3` or newer (Ready X today).

## Mount a checkout

```ts
import { mountCheckout, WalletApiAdapter } from "strk20-pay";

mountCheckout(document.getElementById("checkout"), {
  invoice: {
    id: "order_1042",
    token: "STRK",
    amount: "25",
    mode: "address",
    receiveAddress: "0x…",   // fresh, one per invoice
    network: "mainnet",
    createdAt: Date.now(),
  },
  wallet: new WalletApiAdapter({ network: "mainnet", rpcUrl: "https://rpc.starknet.lava.build" }),
  // Your backend, watching the invoice address. Never `async () => true`.
  confirm: (invoice, txHash) => fetch(`/api/confirm/${invoice.id}`).then((r) => r.ok),
  onPaid: (receipt) => console.log(receipt),
});
```

The widget renders the amount, a confirmation block (what the merchant receives, the pool fee, the
total, the destination, the network), the honesty panel, the pay button, a live progress line, and
the receipt. No framework, no external CSS, no build step required.

## Try it without a wallet

`MockWallet` implements the same interface with play money, including the pool's fee and note
maturation, so the whole flow runs in a test or a demo page:

```ts
import { MockWallet, mountCheckout } from "strk20-pay";

mountCheckout(host, {
  invoice,
  wallet: new MockWallet({ funded: { STRK: "100" } }),
  allowInlineShield: true,
});
```

## Orchestrate it yourself

`StealthCheckout` is the UI-free core. Subscribe to progress and render it however you like:

```ts
import { StealthCheckout } from "strk20-pay";

const checkout = new StealthCheckout(wallet, confirm);
checkout.on((event) => {
  if (event.type === "progress") console.log(event.progress.phase, event.progress.message);
});
const receipt = await checkout.pay(invoice);
```

## Things worth knowing before you ship

- **The pool charges a flat fee per operation, and the direction is not obvious.** 6 STRK on mainnet
  at the time of writing, read live from the pool's `get_fee_amount()`, the same whether you move
  1 STRK or 1,000. It comes **out of** a deposit (send 20, get 14 credited) and **on top of** a
  payment (spend 5, lose 11). So a payer who already holds shielded funds needs `amount + fee`, and
  one who must deposit first needs `amount + 2 x fee`. `depositNeededFor` and `shieldedNeededFor`
  are the two answers; do not compute either by hand. `wallet.poolFee(token)` returns the fee, in
  STRK, or `null` for a token it is not denominated in.
- **A deposit into the pool is public and screened.** Privacy comes from the transfer, not the
  deposit. Shielding the exact invoice amount moments before paying it is the strongest link an
  observer can get, which is why inline shielding is off by default.
- **Notes mature in roughly 10 blocks.** A payment attempted straight after a shield cannot succeed;
  `awaitMaturity` handles the wait and reports progress.
- **Confirm on a delta, never on a balance.** Invoice addresses can already hold funds. The
  reference watcher (`server/watcher` in the repo) captures a baseline at registration and confirms
  on growth; `confirm: async () => true` will ship goods nobody paid for.
- **`mode: "note"` is not headlessly confirmable on mainnet**, because note discovery is not
  available there. Use `mode: "address"` unless you are confirming wallet-side.

## Exports

| Export | What it is |
| --- | --- |
| `mountCheckout` | The drop-in widget |
| `StealthCheckout` | UI-free payment orchestrator |
| `WalletApiAdapter` | Privacy Wallet API adapter (Ready X and friends) |
| `MockWallet` | Play-money wallet with the same interface |
| `depositNeededFor`, `shieldedNeededFor` | What to deposit, and what to hold, given the fee |
| `revealReport` | The honesty panel's rows, for your own UI |
| `TOKENS`, `resolveToken`, `amountToUnits`, `unitsToAmount` | Token registry and amount maths |
| `MATURITY_BLOCKS`, `POOL_ADDRESS`, `EXPLORER_BASE` | Protocol constants |
| `explainWalletError` | Wallet errors turned into something a payer can act on |

Full guide: [docs/INTEGRATION.md](https://github.com/bongbongcrypto/stealth-checkout/blob/main/docs/INTEGRATION.md)

MIT.
