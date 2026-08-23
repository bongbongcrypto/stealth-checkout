// The round-4 pending-payment machinery shipped with zero coverage, and a
// round-5 audit found three defects in it by mutation: deleting the guard at
// checkout.ts entirely left all 117 tests green.
//
// Every test here is written to FAIL if its guard is removed. Where that is not
// obvious the comment says which mutation it catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MockWallet,
  PendingPaymentError,
  StealthCheckout,
  didNotReachTheChain,
} from "../dist/index.js";
import { WalletActionError } from "../dist/wallet/adapter.js";

const invoice = (over = {}) => ({
  id: "inv-p",
  token: "STRK",
  amount: "5",
  mode: "address",
  receiveAddress: "0x0abc",
  network: "sepolia",
  createdAt: Date.now(),
  ...over,
});

const freshStore = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), _map: m };
};

/**
 * A wallet that BROADCASTS and then throws, which is the whole reason the
 * pending marker exists. `submitted` defaults to true on WalletActionError, so
 * an adapter that does not think about it lands here.
 */
function broadcastThenThrow(message, opts = {}) {
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "500" }, ...opts });
  const realUnshield = wallet.unshield.bind(wallet);
  wallet.broadcasts = 0;
  wallet.unshield = async (...args) => {
    await realUnshield(...args); // the money genuinely moves
    wallet.broadcasts++;
    throw new WalletActionError("unshield", message);
  };
  return wallet;
}

test("a wallet that broadcasts then reports a vague error is never paid twice", async () => {
  // Each of these erased the marker when the decision was made by matching
  // words in the message. The wallet vendor chose the wording; we chose to
  // trust it, and the payer paid twice.
  for (const message of [
    "Invalid response from the node",
    "RPC error: invalid JSON-RPC response",
    "Session expired, please reconnect",
    "invalid transaction: already in mempool",
    "Deadline expired while waiting for the receipt",
    "wallet is not connected to the relayer",
  ]) {
    const wallet = broadcastThenThrow(message);
    const store = freshStore();
    const before = await wallet.shieldedBalance("STRK");

    await new StealthCheckout(wallet, async () => true, false, store)
      .pay(invoice())
      .then(() => assert.fail("the wallet threw; this must not resolve"))
      .catch((err) => assert.match(err.message, /./));

    assert.equal(wallet.broadcasts, 1, `${message}: one broadcast so far`);

    // A second page load, same origin, same invoice.
    const second = new StealthCheckout(wallet, async () => true, false, store);
    await second.pay(invoice()).catch(() => {});
    assert.equal(wallet.broadcasts, 1, `${message}: MUST NOT broadcast again`);

    const after = await wallet.shieldedBalance("STRK");
    assert.equal(Number(before) - Number(after), 11, `${message}: 5 paid + 6 fee, once`);
  }
});

test("didNotReachTheChain reads the adapter's own verdict, not its prose", () => {
  // Structural. If this ever goes back to substring matching, the loop above
  // starts failing, and so does this.
  assert.equal(didNotReachTheChain(new WalletActionError("unshield", "invalid", undefined, false)), true);
  assert.equal(didNotReachTheChain(new WalletActionError("unshield", "invalid", undefined, true)), false);
  // The default is the safe one: an adapter that says nothing means "maybe".
  assert.equal(didNotReachTheChain(new WalletActionError("unshield", "anything at all")), false);
  // A plain Error is not an adapter verdict.
  assert.equal(didNotReachTheChain(new Error("expired")), false);
  assert.equal(didNotReachTheChain(undefined), false);
});

test("an error that provably precedes submission does not strand the invoice", async () => {
  // Insufficient funds is raised before anything is built. The payer must be
  // able to top up and pay, not be locked out.
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "1" } });
  const store = freshStore();
  const checkout = new StealthCheckout(wallet, async () => true, false, store);
  await assert.rejects(() => checkout.pay(invoice()), /need 11 STRK shielded/);

  // No marker was left behind, so a funded retry just works.
  const funded = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "50" } });
  const receipt = await new StealthCheckout(funded, async () => true, false, store).pay(invoice());
  assert.equal(receipt.invoiceId, "inv-p");
});

test("a pending payment stops the flow with a distinct, actionable error", async () => {
  const wallet = broadcastThenThrow("the extension went away");
  const store = freshStore();
  await new StealthCheckout(wallet, async () => true, false, store).pay(invoice()).catch(() => {});

  // The merchant cannot see the money either.
  const next = new StealthCheckout(wallet, async () => false, false, store);
  const err = await next.pay(invoice()).then(
    () => assert.fail("must not settle"),
    (e) => e,
  );
  assert.ok(err instanceof PendingPaymentError, `expected PendingPaymentError, got ${err.name}`);
  assert.equal(err.needsPayerCheck, true, "a UI must be able to tell this apart from a retryable failure");
  assert.match(err.message, /check its recent activity/i);
  assert.equal(wallet.broadcasts, 1, "and nothing was sent while asking");
});

test("if the merchant CAN see the money, the pending payment settles instead of asking", async () => {
  const wallet = broadcastThenThrow("connection lost");
  const store = freshStore();
  await new StealthCheckout(wallet, async () => true, false, store).pay(invoice()).catch(() => {});

  const receipt = await new StealthCheckout(wallet, async () => true, false, store).pay(invoice());
  assert.equal(receipt.invoiceId, "inv-p");
  assert.equal(wallet.broadcasts, 1, "settled from the record, not by paying again");
  // The hash is genuinely unknown, and the receipt must say so rather than
  // pointing at nothing.
  assert.equal(receipt.txHash, "");
  assert.match(receipt.disclosure, /hash is not known to this page/);
});

test("paidNothingLastTime actually pays: it opened no wallet at all", async () => {
  // The bug: clearPending emptied the store but left the local `prior`
  // truthy, so control fell into the already-sent branch. The button whose
  // entire purpose is to pay never called the wallet, and told the payer
  // "your payment was sent once" when nothing had been sent.
  const wallet = broadcastThenThrow("the extension went away");
  const store = freshStore();
  await new StealthCheckout(wallet, async () => true, false, store).pay(invoice()).catch(() => {});
  const broadcastsBefore = wallet.broadcasts;

  // The payer looked, saw nothing, and said so. Use a clean wallet: the point
  // is that a payment is attempted at all. The merchant sees nothing for the
  // abandoned attempt's empty hash, and sees the new payment once it lands.
  const clean = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "500" } });
  const seen = [];
  const checkout = new StealthCheckout(
    clean,
    async (_inv, txHash) => {
      seen.push(txHash);
      return txHash !== "";
    },
    false,
    store,
  );
  const receipt = await checkout.pay(invoice(), { paidNothingLastTime: true });
  assert.deepEqual(seen[0], "", "it asks about the abandoned attempt first");

  assert.ok(receipt.txHash, "a real payment happened, with a real hash");
  assert.notEqual(receipt.txHash, "", "not the empty hash of the abandoned attempt");
  assert.equal(wallet.broadcasts, broadcastsBefore, "and the old wallet was not touched again");
  assert.equal(await clean.shieldedBalance("STRK"), "489", "500 - (5 + 6 fee)");
});

test("paidNothingLastTime is inert when nothing is pending", async () => {
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "500" } });
  const checkout = new StealthCheckout(wallet, async () => true, false, freshStore());
  const receipt = await checkout.pay(invoice(), { paidNothingLastTime: true });
  assert.ok(receipt.txHash);
  assert.equal(await wallet.shieldedBalance("STRK"), "489", "exactly one payment");
});

test("a settled invoice is not re-paid, whatever flag is passed", async () => {
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "500" } });
  const store = freshStore();
  await new StealthCheckout(wallet, async () => true, false, store).pay(invoice());
  const afterFirst = await wallet.shieldedBalance("STRK");

  await new StealthCheckout(wallet, async () => true, false, store).pay(invoice(), { paidNothingLastTime: true });
  assert.equal(await wallet.shieldedBalance("STRK"), afterFirst, "the record still wins");
});
