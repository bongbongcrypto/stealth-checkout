import { test } from "node:test";
import assert from "node:assert/strict";
import { MockWallet, StealthCheckout, addAmounts, compareAmounts, revealReport } from "../dist/index.js";

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

// The pool charges a flat 6 STRK per operation, so a 1 STRK invoice paid from
// scratch costs 14: shield 1+6 and pay 1+6. Fixtures are funded accordingly;
// anything tighter is testing a flow that cannot happen on mainnet.
const fastWallet = (opts = {}) => new MockWallet({ latency: 1, funded: { STRK: "100" }, ...opts });

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
  assert.equal(await wallet.shieldedBalance("STRK"), "0", "shielded amount+fee, spent amount+fee");
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
  await wallet.shield("STRK", "20");
  wallet.shieldedBalance = async () => null;
  const checkout = new StealthCheckout(wallet);
  const phases = collectPhases(checkout);

  const receipt = await checkout.pay(invoice());

  assert.ok(!phases.includes("shielding"), "should not shield when funds may already be there");
  assert.equal(receipt.shieldTxHash, undefined);
  assert.equal(await wallet.publicBalance("STRK"), "74"); // 100 - (20 shielded + 6 fee)
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
  await wallet.shield("STRK", "20"); // comfortably covers 1 + the 6 fee
  const checkout = new StealthCheckout(wallet);
  const phases = collectPhases(checkout);

  await checkout.pay(invoice());

  assert.ok(!phases.includes("shielding"));
  assert.ok(!phases.includes("maturing"));
  assert.deepEqual(phases.slice(-2), ["confirming", "paid"]);
  assert.equal(await wallet.shieldedBalance("STRK"), "13", "20 shielded, 1 paid, 6 fee");
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
  const wallet = fastWallet({ funded: { STRK: "0.5" } }); // cannot even cover the fee
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
    // The refusal must quote real arithmetic: 1 to the merchant, 6 to the pool.
    assert.match(err.message, /need 7 STRK shielded/i);
    assert.match(err.message, /flat 6 STRK for the payment itself/i);
    assert.match(err.message, /linked to it by amount and timing/i);
    assert.match(err.message, /ten blocks/i);
    return true;
  });

  assert.ok(!phases.includes("shielding"), "no deposit is made");
  assert.equal(await wallet.publicBalance("STRK"), "100", "no funds moved");
});

test("a retry after a failed confirmation never sends money twice", async () => {
  // The chain was slow, confirmation timed out, the widget offered Retry.
  // Before the fix this broadcast a second unshield and the payer paid twice.
  const wallet = fastWallet();
  let confirmations = 0;
  const checkout = new StealthCheckout(wallet, async () => ++confirmations > 1, true);

  await assert.rejects(() => checkout.pay(invoice()), /was sent once and will not be sent again/);
  const spentAfterFirst = await wallet.shieldedBalance("STRK");

  const receipt = await checkout.pay(invoice());
  assert.equal(receipt.invoiceId, "inv-1");
  assert.equal(
    await wallet.shieldedBalance("STRK"),
    spentAfterFirst,
    "the retry must confirm the existing payment, not make a new one",
  );
});

test("the receipt reports the wallet's network, not the invoice's claim", async () => {
  const wallet = fastWallet(); // sepolia
  const checkout = new StealthCheckout(wallet, undefined, true);
  const receipt = await checkout.pay(invoice({ network: "sepolia" }));
  assert.equal(receipt.network, "sepolia");
});

test("paying a mainnet invoice from a sepolia wallet is refused before any prompt", async () => {
  const wallet = fastWallet();
  const checkout = new StealthCheckout(wallet, undefined, true);
  await assert.rejects(() => checkout.pay(invoice({ network: "mainnet" })), /invoice is for mainnet.*wallet is on sepolia/);
  assert.equal(await wallet.publicBalance("STRK"), "100", "no funds moved");
});

test("a reload cannot re-send a payment: the record is persisted", async () => {
  // The payer's confirmation timed out and they pressed F5. A fresh page means
  // a fresh StealthCheckout, and without a persisted record it pays again.
  const store = new Map();
  const shared = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const wallet = fastWallet();
  await wallet.connect();
  await wallet.shield("STRK", "20");

  const page1 = new StealthCheckout(wallet, async () => false, false, shared);
  await assert.rejects(() => page1.pay(invoice()), /sent once/);
  const afterFirst = await wallet.shieldedBalance("STRK");

  // A brand new instance, as after a reload.
  const page2 = new StealthCheckout(wallet, async () => true, false, shared);
  const receipt = await page2.pay(invoice());
  assert.equal(await wallet.shieldedBalance("STRK"), afterFirst, "reload must not spend again");
  assert.equal(receipt.invoiceId, "inv-1");
});

test("a remembered payment cannot be claimed by a different invoice reusing its id", async () => {
  const store = new Map();
  const shared = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const wallet = fastWallet({ funded: { STRK: "200" } });
  await wallet.connect();
  await wallet.shield("STRK", "150");

  const first = new StealthCheckout(wallet, async () => false, false, shared);
  await assert.rejects(() => first.pay(invoice({ amount: "1" })), /sent once/);

  // Same id, far larger amount: must NOT be waved through as already paid.
  const second = new StealthCheckout(wallet, async () => true, false, shared);
  const before = await wallet.shieldedBalance("STRK");
  const receipt = await second.pay(invoice({ amount: "50" }));
  assert.equal(receipt.amount, "50");
  assert.notEqual(await wallet.shieldedBalance("STRK"), before, "a genuinely different payment must be made");
});

test("the same address written differently is still the same address", async () => {
  // Starknet addresses have no canonical text form. Comparing the strings made
  // a re-rendered address look new, and the payment went out a second time.
  const store = new Map();
  const shared = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const wallet = fastWallet({ funded: { STRK: "100" } });
  await wallet.connect();
  await wallet.shield("STRK", "80");

  const first = new StealthCheckout(wallet, async () => false, false, shared);
  await assert.rejects(() => first.pay(invoice({ receiveAddress: "0x00abc" })));
  const spent = await wallet.shieldedBalance("STRK");

  for (const spelling of ["0xabc", "0x0ABC", "0x000000abc"]) {
    const again = new StealthCheckout(wallet, async () => true, false, shared);
    await again.pay(invoice({ receiveAddress: spelling }));
    assert.equal(await wallet.shieldedBalance("STRK"), spent, `${spelling} must not re-send`);
  }
});

test("a stale record for another invoice cannot shadow this one", async () => {
  const store = new Map();
  const shared = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const wallet = fastWallet({ funded: { STRK: "100" } });
  await wallet.connect();
  await wallet.shield("STRK", "80");

  const paidB = new StealthCheckout(wallet, async () => true, false, shared);
  await paidB.pay(invoice({ id: "B" }));
  const afterB = await wallet.shieldedBalance("STRK");

  // Same instance now attempts C and fails, leaving C in memory.
  await assert.rejects(() => new StealthCheckout(wallet, async () => false, false, shared).pay(invoice({ id: "C" })));

  // B is already settled: paying it again must not move money.
  const again = new StealthCheckout(wallet, async () => true, false, shared);
  again.sentPayment = { invoiceId: "C", amount: "1", token: "STRK", recipient: "0x0abc", txHash: "0xdead" };
  const before = await wallet.shieldedBalance("STRK");
  await again.pay(invoice({ id: "B" }));
  assert.equal(await wallet.shieldedBalance("STRK"), before, "B must not be paid twice");
  assert.ok(afterB >= "0");
});

test("a corrupt stored record is ignored, not fatal", async () => {
  const store = new Map([["strk20-pay.sent.sepolia.inv-1", '{"amount":"abc","invoiceId":"inv-1"}']]);
  const shared = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const wallet = fastWallet();
  const checkout = new StealthCheckout(wallet, async () => true, true, shared);
  const receipt = await checkout.pay(invoice());
  assert.equal(receipt.invoiceId, "inv-1", "a poisoned record must not brick the invoice");
});

test("the pool's flat fee is part of every amount decision", async () => {
  // The pool charges 6 STRK per operation on top of the invoice. Gating on the
  // amount alone let a payer through who then hit an opaque wallet error with
  // their money already in the pool.
  const wallet = fastWallet();
  await wallet.connect();
  await wallet.shield("STRK", "5"); // 5 shielded: enough for the amount, NOT the fee
  const checkout = new StealthCheckout(wallet);

  await assert.rejects(() => checkout.pay(invoice({ amount: "5" })), (err) => {
    assert.match(err.message, /need 11 STRK shielded/, "5 to the merchant plus 6 to the pool");
    return true;
  });
});

test("inline shielding deposits enough to afford the payment that follows", async () => {
  // Shielding exactly the invoice amount credits the amount, then the payment
  // needs amount + fee, so it could never succeed on mainnet at any size.
  const wallet = fastWallet();
  const checkout = new StealthCheckout(wallet, async () => true, true);
  const shielded = [];
  checkout.on((e) => {
    if (e.type === "progress" && e.progress.phase === "shielding") shielded.push(e.progress.message);
  });

  const receipt = await checkout.pay(invoice({ amount: "5" }));

  assert.match(shielded[0], /shield 11 STRK/, "deposits amount + fee");
  assert.ok(receipt.txHash);
  assert.equal(await wallet.shieldedBalance("STRK"), "0", "deposit exactly covered the payment");
});

test("the two amount helpers agree on what an amount is", () => {
  // They did not. compareAmounts accepted ".5" and addAmounts threw on it, so
  // the same string passed a sufficiency check and then failed mid-payment.
  // And addAmounts truncated below the token's precision while compareAmounts
  // counted it, so the two disagreed about whether dust was more than zero.
  const both = (x) => {
    const results = [];
    for (const fn of [() => compareAmounts(x, "1"), () => addAmounts(x, "1")]) {
      try {
        fn();
        results.push("ok");
      } catch {
        results.push("throws");
      }
    }
    return results;
  };
  for (const input of ["", ".5", "5.", "1e3", "-1", "0x1", "1,5", "NaN", " ", "0.0000000000000000001"]) {
    const [cmp, add] = both(input);
    assert.equal(cmp, add, `compareAmounts and addAmounts disagree about ${JSON.stringify(input)}`);
    assert.equal(cmp, "throws", `${JSON.stringify(input)} should be refused`);
  }
  for (const input of ["0", "1", "007", "1.10", "  5  ", "0.000000000000000001"]) {
    const [cmp, add] = both(input);
    assert.equal(cmp, "ok", `${JSON.stringify(input)} should be accepted by compareAmounts`);
    assert.equal(add, "ok", `${JSON.stringify(input)} should be accepted by addAmounts`);
  }
});

test("addAmounts is exact, and never silently drops precision", () => {
  assert.equal(addAmounts("5", "6"), "11");
  assert.equal(addAmounts("0.1", "0.2"), "0.3"); // the float trap
  assert.equal(addAmounts("1.999999999999999999", "0.000000000000000001"), "2");
  assert.throws(() => addAmounts("abc", "1"), /Not a valid amount/);
  assert.equal(addAmounts("1", "6"), "7"); // an invoice plus the pool's fee
  assert.equal(addAmounts("0.000000000000000001", "0"), "0.000000000000000001");
  assert.equal(addAmounts("999999999999999999999999", "1"), "1000000000000000000000000");
  // Truncation must be an error, not a rounding-down of someone's money.
  assert.throws(() => addAmounts("1.0000000000000000001", "1"), /more than 18 decimal places/);
  // A six-decimal token refuses what an eighteen-decimal one accepts.
  assert.equal(addAmounts("1.5", "0.25", 6), "1.75");
  assert.throws(() => addAmounts("1.0000001", "1", 6), /more than 6 decimal places/);
});
