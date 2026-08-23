// The round-4 pending-payment machinery shipped with zero coverage, and a
// round-5 audit found three defects in it by mutation: deleting the guard at
// checkout.ts entirely left all 117 tests green.
//
// Every test here is written to FAIL if its guard is removed. Where that is not
// obvious the comment says which mutation it catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InvoiceSettledError,
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

test("a merchant reporting the invoice settled ends the flow WITHOUT a receipt", async () => {
  // `confirm` answers "is this invoice paid?" - every implementation in the
  // docs ignores the hash it is handed. So a settled answer is not evidence
  // that THIS payer paid, and on a shared link one person's money used to mint
  // a receipt for another, who had broadcast nothing, and fire onPaid so the
  // merchant handed over goods.
  const wallet = broadcastThenThrow("connection lost");
  const store = freshStore();
  await new StealthCheckout(wallet, async () => true, false, store).pay(invoice()).catch(() => {});

  const err = await new StealthCheckout(wallet, async () => true, false, store).pay(invoice()).then(
    (r) => assert.fail(`must not mint a receipt: ${JSON.stringify(r)}`),
    (e) => e,
  );
  assert.ok(err instanceof InvoiceSettledError, `expected InvoiceSettledError, got ${err.name}`);
  assert.equal(err.alreadySettled, true, "a UI must be able to render this as terminal, not retryable");
  assert.match(err.message, /cannot tell whether that payment was yours/i);
  assert.equal(wallet.broadcasts, 1, "and nothing was paid again while finding out");
});

test("a stranger's payment on a shared link cannot mint someone else's receipt", async () => {
  // The concrete harm: two people open one link, B's wallet fails after the
  // marker is written, A pays, and B clicks again.
  const shared = freshStore();
  const b = broadcastThenThrow("the extension went away");
  b.broadcasts = 0;
  const bBefore = await b.shieldedBalance("STRK");
  await new StealthCheckout(b, async () => true, false, shared).pay(invoice()).catch(() => {});

  // A has since paid, so the merchant now says the invoice is settled.
  let paidFired = false;
  const err = await new StealthCheckout(b, async () => true, false, shared)
    .pay(invoice())
    .then(() => (paidFired = true), (e) => e);

  assert.ok(err instanceof InvoiceSettledError);
  assert.equal(paidFired, false, "onPaid must not fire for a payment B never made");
  assert.equal(b.broadcasts, 1, "B broadcast once, at the very start, and never again");
  assert.equal(Number(bBefore) - Number(await b.shieldedBalance("STRK")), 11, "B paid exactly once");
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

test("the wallet's own error codes decide whether anything was submitted", async () => {
  // Two rounds tried to answer this by matching words. The first matched too
  // much and re-sent payments; the second missed USER_REFUSED_OP - the actual
  // code, 113, declared in @starknet-io/starknet-types-0103 in this repo's own
  // node_modules - so an ordinary Reject locked the payer out of their invoice.
  const { didNotSubmit, WALLET_ERROR_CODES } = await import("../dist/index.js");
  const wallet = (code) => Object.assign(new Error(`An error occurred (${code})`), { code });

  // Everything the wallet raises while deciding whether to sign.
  for (const name of [
    "USER_REFUSED_OP",
    "INVALID_REQUEST_PAYLOAD",
    "NOT_REGISTERED",
    "INSUFFICIENT_PRIVATE_BALANCE",
    "PRIVACY_LEAK",
    "API_VERSION_NOT_SUPPORTED",
    "CHAIN_ID_NOT_SUPPORTED",
  ]) {
    assert.equal(didNotSubmit(wallet(WALLET_ERROR_CODES[name])), true, `${name} precedes submission`);
  }
  // Unknown means unknown, and the safe reading is "the money may be gone".
  assert.equal(didNotSubmit(wallet(WALLET_ERROR_CODES.UNKNOWN_ERROR)), false);
  // A code can arrive nested, as JSON-RPC wrappers do.
  assert.equal(didNotSubmit({ cause: { code: 113 } }), true);
  assert.equal(didNotSubmit({ error: { code: 163 } }), false);

  // With no code at all, the message is the only evidence, and it stays narrow.
  assert.equal(didNotSubmit(new Error("USER_REFUSED_OP")), true, "no word boundary after the phrase");
  assert.equal(didNotSubmit({ message: "Rejected by user" }), true, "a plain object, which is the spec's shape");
  assert.equal(didNotSubmit(new Error("Transaction rejected by the sequencer")), false);
  assert.equal(didNotSubmit(new Error("INSUFFICIENT_MAX_FEE")), false, "a node error, raised after submission");
  assert.equal(didNotSubmit(new Error("timed out")), false);

  // "abort" is deliberately NOT a refusal, and an earlier version of this test
  // asserted the opposite. It is what a TRANSPORT says when a request is cut
  // off - Chrome's own AbortError reads "The user aborted a request." - so
  // treating it as a decision cleared the marker that stops a double payment
  // and a lost response after a successful broadcast paid the invoice twice.
  // The cost of excluding it is one extra confirmation for a wallet that sends
  // a bare "User abort" and no code; the cost of including it is money.
  assert.equal(didNotSubmit(new Error("The user aborted a request.")), false);
  assert.equal(didNotSubmit(new Error("User abort")), false);
  // A wallet that sends the code is unaffected either way.
  assert.equal(didNotSubmit({ code: 113, message: "User abort" }), true);

  // An unrecognised code must not silence the message. Returning the set
  // membership for ANY code meant EIP-1193's 4001 read as "may have been
  // submitted" while the payer was told they had dismissed the prompt.
  assert.equal(didNotSubmit({ code: 4001, message: "User rejected the request." }), true);
  assert.equal(didNotSubmit({ code: 9999, message: "Rejected by user" }), true, "unknown code, clear message");
  assert.equal(didNotSubmit({ code: 9999, message: "something went wrong" }), false);
});

test("the real adapter labels every documented wallet code correctly", async () => {
  // The wiring, end to end: a code goes into the extension stub and comes out
  // as `submitted` on the error the checkout reads.
  const { WalletApiAdapter, WALLET_ERROR_CODES } = await import("../dist/index.js");
  const adapterFor = (code) => {
    const a = new WalletApiAdapter({ network: "sepolia", rpcUrl: "http://127.0.0.1:1" });
    a.account = { address: "0x0abc" };
    a.accountV6 = {
      strk20InvokeTransaction: async () => {
        throw Object.assign(new Error(`An error occurred (${code})`), { code });
      },
    };
    return a;
  };
  const expected = {
    [WALLET_ERROR_CODES.USER_REFUSED_OP]: false,
    [WALLET_ERROR_CODES.INVALID_REQUEST_PAYLOAD]: false,
    [WALLET_ERROR_CODES.NOT_REGISTERED]: false,
    [WALLET_ERROR_CODES.INSUFFICIENT_PRIVATE_BALANCE]: false,
    [WALLET_ERROR_CODES.PRIVACY_LEAK]: false,
    [WALLET_ERROR_CODES.API_VERSION_NOT_SUPPORTED]: false,
    [WALLET_ERROR_CODES.UNKNOWN_ERROR]: true,
  };
  for (const [code, submitted] of Object.entries(expected)) {
    const err = await adapterFor(Number(code)).unshield("STRK", "1", "0x0def").then(() => null, (e) => e);
    assert.ok(err, `code ${code} should throw`);
    assert.equal(err.submitted, submitted, `code ${code}: submitted should be ${submitted}`);
  }
});

test("the pool's own shortfall code still shields and pays, once", async () => {
  // INSUFFICIENT_PRIVATE_BALANCE is code 119, raised before signing. Round 6
  // labelled it "may have been submitted", which made the whole shield-then-pay
  // branch dead code with the shipped adapter: the payer was refused and then
  // locked out.
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "500" }, shielded: { STRK: "0" } });
  wallet.shieldedBalance = async () => null;
  let attempts = 0;
  const realUnshield = wallet.unshield.bind(wallet);
  wallet.unshield = async (...args) => {
    attempts++;
    if (attempts === 1) {
      throw Object.assign(new WalletActionError("unshield", "An error occurred (INSUFFICIENT_PRIVATE_BALANCE)", undefined, false), {
        code: 119,
      });
    }
    return realUnshield(...args);
  };

  const receipt = await new StealthCheckout(wallet, async () => true, true, freshStore()).pay(invoice());
  assert.ok(receipt.shieldTxHash, "it shielded rather than giving up");
  assert.equal(attempts, 2, "one refusal, then one that worked");
});

test("the payment record is keyed by the invoice's terms, not just its id", async () => {
  // `?id=` is chosen by whoever writes the link, so a second invoice reusing
  // one overwrote the first's record. The first link then had no memory of its
  // own payment and broadcast it again.
  const store = freshStore();
  const wallet = new MockWallet({ latency: 0, funded: { STRK: "900" }, shielded: { STRK: "900" } });
  let sends = 0;
  const realUnshield = wallet.unshield.bind(wallet);
  wallet.unshield = async (...args) => {
    sends++;
    return realUnshield(...args);
  };

  const A = invoice({ id: "order-1", amount: "5", receiveAddress: "0x0aaa" });
  const B = invoice({ id: "order-1", amount: "1", receiveAddress: "0x0bbb" }); // same id, other terms

  await new StealthCheckout(wallet, async () => true, false, store).pay(A);
  assert.equal(sends, 1);
  await new StealthCheckout(wallet, async () => true, false, store).pay(B);
  assert.equal(sends, 2, "a genuinely different invoice is paid");

  // Back on A: its record must still be there.
  await new StealthCheckout(wallet, async () => true, false, store).pay(A);
  assert.equal(sends, 2, "A was already paid and must not be paid a third time");
});

test("a payer sees a usable message for every documented error shape", async () => {
  // The Wallet API declares its errors as plain { code, message } objects, not
  // Error instances, so reading them with String(err) produced the literal
  // text "[object Object]" - shown to the payer, and killing every prose
  // branch at once.
  const { explainWalletError, walletErrorMessage } = await import("../dist/index.js");
  const shapes = [
    { code: 113, message: "An error occurred (USER_REFUSED_OP)" },
    { code: 118, message: "An error occurred (NOT_REGISTERED)" },
    { code: 119, message: "An error occurred (INSUFFICIENT_PRIVATE_BALANCE)" },
    { code: 120, message: "An error occurred (PRIVACY_LEAK)" },
    { code: 163, message: "An error occurred (UNKNOWN_ERROR)" },
    { code: -32603, message: "Internal error", data: { code: 113, message: "refused" } },
  ];
  for (const shape of shapes) {
    const text = explainWalletError(shape, "unshield");
    assert.doesNotMatch(text, /\[object Object\]/, `code ${shape.code} must not stringify to junk`);
    assert.ok(text.trim().length > 10, `code ${shape.code} must say something useful: ${text}`);
    assert.ok(walletErrorMessage(shape).length > 0);
  }
  // And an error with no message at all still yields a sentence.
  assert.doesNotMatch(explainWalletError({}, "shield"), /\[object Object\]|^$/);
});
