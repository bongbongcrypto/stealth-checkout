import { test } from "node:test";
import assert from "node:assert/strict";
import { MockWallet, StealthCheckout, compareAmounts, revealReport } from "../dist/index.js";

const invoice = (over = {}) => ({
  id: "inv-1",
  token: "STRK",
  amount: "1",
  mode: "address",
  receiveAddress: "0x0abc",
  network: "sepolia",
  createdAt: Date.now(),
  ...over,
});

const fastWallet = (opts = {}) => new MockWallet({ latency: 1, funded: { STRK: "10" }, ...opts });

/** Phases in order, collapsing repeats (maturing ticks once per block left). */
function collectPhases(checkout) {
  const phases = [];
  checkout.on((e) => {
    if (e.type === "progress" && phases.at(-1) !== e.progress.phase) phases.push(e.progress.phase);
  });
  return phases;
}

test("full flow: connect → shield → mature → pay → confirm → paid", async () => {
  const wallet = fastWallet();
  let confirmedHash = null;
  const checkout = new StealthCheckout(wallet, async (_inv, txHash) => {
    confirmedHash = txHash;
    return true;
  }, true);
  const phases = collectPhases(checkout);

  const receipt = await checkout.pay(invoice());

  assert.deepEqual(phases, ["connecting", "preparing", "shielding", "maturing", "paying", "confirming", "paid"]);
  assert.equal(receipt.invoiceId, "inv-1");
  assert.equal(receipt.txHash, confirmedHash);
  assert.ok(receipt.shieldTxHash, "shield hash is kept on the receipt");
  assert.notEqual(receipt.shieldTxHash, receipt.txHash);
  assert.match(receipt.disclosure, /Does not link/);
  assert.equal(await wallet.shieldedBalance("STRK"), "0"); // shielded exactly what was spent
});

test("maturity is awaited after shielding, and reports blocks left", async () => {
  const wallet = fastWallet();
  const checkout = new StealthCheckout(wallet, undefined, true);
  const waits = [];
  checkout.on((e) => {
    if (e.type === "progress" && e.progress.phase === "maturing") waits.push(e.progress.message);
  });
  await checkout.pay(invoice());
  assert.ok(waits.length > 1, "maturity should report progress, not pass instantly");
  assert.ok(waits.some((m) => /block\(s\) to go/.test(m)));
});

test("an unknown shielded balance pays first instead of shielding again", async () => {
  // A wallet that refuses to report balances but is funded in the pool: the
  // flow must not spend a second deposit to find that out.
  const wallet = fastWallet();
  await wallet.connect();
  await wallet.shield("STRK", "5");
  wallet.shieldedBalance = async () => null;
  const checkout = new StealthCheckout(wallet);
  const phases = collectPhases(checkout);

  const receipt = await checkout.pay(invoice());

  assert.ok(!phases.includes("shielding"), "should not shield when funds may already be there");
  assert.equal(receipt.shieldTxHash, undefined);
  assert.equal(await wallet.publicBalance("STRK"), "5"); // only the original shield left public funds
});

test("unknown balance still shields when the wallet reports insufficient funds", async () => {
  const wallet = fastWallet();
  wallet.shieldedBalance = async () => null;
  const checkout = new StealthCheckout(wallet, undefined, true);
  const phases = collectPhases(checkout);

  const receipt = await checkout.pay(invoice());

  assert.ok(phases.includes("shielding"), "falls back to shielding after the insufficient-funds error");
  assert.ok(receipt.shieldTxHash);
});

test("already-shielded balance skips the shield phase", async () => {
  const wallet = fastWallet();
  await wallet.connect();
  await wallet.shield("STRK", "5");
  const checkout = new StealthCheckout(wallet);
  const phases = collectPhases(checkout);

  await checkout.pay(invoice());

  assert.ok(!phases.includes("shielding"));
  assert.ok(!phases.includes("maturing"));
  assert.deepEqual(phases.slice(-2), ["confirming", "paid"]);
  assert.equal(await wallet.shieldedBalance("STRK"), "4");
});

test("note mode uses privateTransfer and a note receipt", async () => {
  const wallet = fastWallet();
  const checkout = new StealthCheckout(wallet, undefined, true);
  const receipt = await checkout.pay(invoice({ mode: "note", receiveAddress: undefined, merchantPoolAddress: "0x0pool" }));
  assert.equal(receipt.mode, "note");
  assert.match(receipt.disclosure, /Amount and parties are not on-chain/);
});

test("wallet failure surfaces as a failed event and a rejection", async () => {
  const wallet = fastWallet({ failAt: "unshield" });
  const checkout = new StealthCheckout(wallet, undefined, true);
  let failedEvent = null;
  checkout.on((e) => {
    if (e.type === "failed") failedEvent = e;
  });
  await assert.rejects(() => checkout.pay(invoice()), /prove the withdrawal/);
  assert.ok(failedEvent);
  assert.match(failedEvent.error, /prove the withdrawal/);
});

test("unconfirmed payment fails rather than minting a receipt", async () => {
  const checkout = new StealthCheckout(fastWallet(), async () => false, true);
  await assert.rejects(() => checkout.pay(invoice()), /not confirmed/);
});

test("expired invoice never touches the wallet", async () => {
  const wallet = fastWallet({ failAt: "connect" }); // would throw if touched
  const checkout = new StealthCheckout(wallet);
  await assert.rejects(() => checkout.pay(invoice({ expiresAt: Date.now() - 1000 })), /expired/);
});

test("missing receive address is rejected", async () => {
  const checkout = new StealthCheckout(fastWallet(), undefined, true);
  await assert.rejects(() => checkout.pay(invoice({ receiveAddress: undefined })), /missing its receive address/);
});

test("insufficient funds fails at shield with a clear message", async () => {
  const wallet = fastWallet({ funded: { STRK: "0.5" } });
  const checkout = new StealthCheckout(wallet, undefined, true);
  await assert.rejects(() => checkout.pay(invoice()), /Insufficient STRK/);
});

test("a second pay while in-flight is rejected", async () => {
  const wallet = fastWallet({ latency: 30 });
  const checkout = new StealthCheckout(wallet, undefined, true);
  const first = checkout.pay(invoice());
  await assert.rejects(() => checkout.pay(invoice({ id: "inv-2" })), /already in progress/);
  await first;
});

test("compareAmounts handles decimals without floats", () => {
  assert.equal(compareAmounts("1", "1"), 0);
  assert.equal(compareAmounts("1.50", "1.5"), 0);
  assert.equal(compareAmounts("0.5", "1"), -1);
  assert.equal(compareAmounts("10", "9"), 1);
  assert.equal(compareAmounts("0.000000000000000001", "0"), 1);
  assert.equal(compareAmounts("00.10", "0.1"), 0);
});

test("honesty report: address mode admits what is public", () => {
  const rows = revealReport(invoice(), true);
  const publicFacts = rows.filter((r) => r.visibility === "public").map((r) => r.fact);
  assert.ok(publicFacts.some((f) => /deposit/i.test(f)));
  assert.ok(publicFacts.some((f) => /Invoice address/i.test(f)));
  assert.ok(rows.some((r) => r.visibility === "hidden" && /your wallet/i.test(r.fact)));
});

test("honesty report: note mode hides amount and parties but admits timing", () => {
  const rows = revealReport(invoice({ mode: "note" }), false);
  assert.ok(rows.some((r) => r.visibility === "hidden" && /Amount and both parties/.test(r.fact)));
  assert.ok(rows.some((r) => r.visibility === "public" && /Timing/i.test(r.fact)));
});

test("by default the widget refuses to shield inline, and says why", async () => {
  // The protocol's own guidance: a deposit is a public leg naming the payer,
  // so shielding moments before paying is what makes the two correlatable.
  const wallet = fastWallet();
  const checkout = new StealthCheckout(wallet);
  const phases = collectPhases(checkout);

  await assert.rejects(() => checkout.pay(invoice()), (err) => {
    assert.match(err.message, /need at least 1 STRK shielded/i);
    assert.match(err.message, /fee per deposit/i);
    assert.match(err.message, /linked to it by amount and timing/i);
    assert.match(err.message, /ten blocks/i);
    return true;
  });

  assert.ok(!phases.includes("shielding"), "no deposit is made");
  assert.equal(await wallet.publicBalance("STRK"), "10", "no funds moved");
});
