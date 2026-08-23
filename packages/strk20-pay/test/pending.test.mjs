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

test("a node reporting 'insufficient' AFTER submission never triggers a second payment", async () => {
  // Round 6's critical. The retry branch decided to re-broadcast by matching
  // the word "insufficient" in an error, and INSUFFICIENT_MAX_FEE /
  // INSUFFICIENT_ACCOUNT_BALANCE come from the catch AROUND the submit call.
  // On the inline-shield path this spent the invoice twice plus a needless
  // deposit; on the default path it blanked the marker so every retry did it
  // again. The technique had been removed from the sibling branch one round
  // earlier and left running here.
  for (const message of ["Not enough balance to pay, including fees.", "INSUFFICIENT_MAX_FEE", "insufficient funds"]) {
    const wallet = broadcastThenThrow(message);
    // The balance is unreadable, which is what routes into this branch at all.
    wallet.shieldedBalance = async () => null;
    const store = freshStore();

    await new StealthCheckout(wallet, async () => true, true, store).pay(invoice()).catch(() => {});
    assert.equal(wallet.broadcasts, 1, `${message}: must not pay twice inside one call`);

    // And a retry must not either.
    await new StealthCheckout(wallet, async () => true, true, store).pay(invoice()).catch(() => {});
    assert.equal(wallet.broadcasts, 1, `${message}: must not pay again on retry`);
  }
});

test("a genuine pre-submission shortfall still shields and pays, once", async () => {
  // The legitimate half of the same branch must keep working: MockWallet
  // labels its insufficient error submitted:false, so this is allowed to
  // deposit and try again.
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "0" } });
  wallet.shieldedBalance = async () => null;
  let unshields = 0;
  const realUnshield = wallet.unshield.bind(wallet);
  wallet.unshield = async (...args) => {
    unshields++;
    return realUnshield(...args);
  };

  const receipt = await new StealthCheckout(wallet, async () => true, true, freshStore()).pay(invoice());
  assert.ok(receipt.shieldTxHash, "it shielded");
  assert.equal(unshields, 2, "one failed attempt, then one that worked");
  assert.equal(await wallet.shieldedBalance.call(wallet), null);
});

test("dismissing the wallet prompt does not brand the invoice as maybe-paid", async () => {
  // A refusal means the wallet signed nothing. Treating it as "you may have
  // already paid" froze the widget behind a ten-minute probe after one
  // mis-click, and taught payers to reach for the double-spend escape hatch.
  const { userRefused } = await import("../dist/wallet/walletapi.js");
  for (const raw of [
    "USER_REFUSED",
    "User rejected the request",
    "The user denied the transaction",
    "Rejected by user",
    "user cancelled",
  ]) {
    assert.equal(userRefused(new Error(raw)), true, `${raw} is a refusal`);
  }
  for (const raw of ["INSUFFICIENT_MAX_FEE", "Invalid response from the node", "timeout", ""]) {
    assert.equal(userRefused(new Error(raw)), false, `${raw} is NOT a refusal`);
  }

  // End to end: a refusing wallet leaves the invoice payable.
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "500" } });
  wallet.unshield = async () => {
    throw new WalletActionError("unshield", "You dismissed the wallet prompt.", undefined, false);
  };
  const store = freshStore();
  await new StealthCheckout(wallet, async () => true, false, store).pay(invoice()).catch(() => {});

  const clean = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "500" } });
  const receipt = await new StealthCheckout(clean, async () => true, false, store).pay(invoice());
  assert.ok(receipt.txHash, "the payer can simply try again, with no scary detour");
  assert.equal(await clean.shieldedBalance("STRK"), "489");
});

test("the adapter itself labels a refusal as not-submitted, and everything else as maybe", async () => {
  // The wiring, not the two halves. Testing `userRefused` alone and the
  // checkout alone left the line that joins them - `!userRefused(err)` at the
  // submit catch - free to be deleted with every test still green.
  const { WalletApiAdapter } = await import("../dist/wallet/walletapi.js");

  const adapterThatThrows = (raw) => {
    const a = new WalletApiAdapter({ network: "sepolia", rpcUrl: "http://127.0.0.1:1" });
    // Stand in for a connected wallet extension. These are the only two things
    // `invoke` needs before it reaches the submit call.
    a.account = { address: "0x0abc" };
    a.accountV6 = {
      strk20InvokeTransaction: async () => {
        throw new Error(raw);
      },
    };
    return a;
  };

  const refusals = ["USER_REFUSED", "User rejected the request", "user cancelled the transaction"];
  for (const raw of refusals) {
    const err = await adapterThatThrows(raw)
      .unshield("STRK", "1", "0x0def")
      .then(() => null, (e) => e);
    assert.ok(err, `${raw} should throw`);
    assert.equal(err.submitted, false, `${raw}: the wallet signed nothing`);
    assert.equal(didNotReachTheChain(err), true);
  }

  // Everything else keeps the safe default, including errors that merely
  // mention money.
  for (const raw of ["INSUFFICIENT_MAX_FEE", "Invalid response from the node", "timed out", "boom"]) {
    const err = await adapterThatThrows(raw)
      .unshield("STRK", "1", "0x0def")
      .then(() => null, (e) => e);
    assert.ok(err, `${raw} should throw`);
    assert.equal(err.submitted, true, `${raw}: this may have reached the network`);
    assert.equal(didNotReachTheChain(err), false);
  }
});
