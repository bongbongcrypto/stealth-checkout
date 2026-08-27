# Builders-group announcement (draft for owner to post)

> Post this in the STRK20 sprint Telegram when ready. Plain text below the line.

---

shipped something the other 130+ teams here might actually want to use

**Stealth Checkout**: the accepting side of STRK20. everyone is building rails to send money privately, so we built the part where your app gets paid.

what you can grab today, MIT:

1. invoice links, zero code: create a link, payer gets a full private checkout (pay from shielded funds, receipt). confirmation runs in their browser over public RPC
2. drop-in widget: one mount() call renders button + progress + a pre-sign panel that tells the payer exactly what goes on-chain and what stays hidden. no framework needed
3. headless webhooks: a zero-dep watcher polls invoice addresses over plain JSON-RPC and fires HMAC-signed payment.confirmed hooks. no proving service, no discovery endpoint. proven on mainnet: tx #8 in our strk20.json is a real end-to-end invoice payment, paid through the pool to a fresh address, confirmed by the watcher, webhook delivered. the 3-min video is a recording of it happening

selling game credits, sub tiers, bounty escrows, anything: if your project needs "user pays, app finds out", this is that layer. 8 verified mainnet txs, 205 tests, MIT.

repo: github.com/bongbongcrypto/stealth-checkout
demo (mock wallet, zero setup): bongbongcrypto.github.io/stealth-checkout
integration guide: github.com/bongbongcrypto/stealth-checkout/blob/main/docs/INTEGRATION.md
video (3 min): github.com/bongbongcrypto/stealth-checkout/blob/main/docs/demo.mp4

if you wire it into your entry, tell me what broke and I will fix it same day.
