// Regression tests for the defects an adversarial audit found. Each one here
// corresponds to a way real money was lost or forged before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELETABLE_STATES,
  LATE_GRACE_MS,
  SETTLED_STATES,
  UNPAYABLE_STATES,
  evaluateInvoice,
  hasUsableBaseline,
  sameAddress,
  shouldPoll,
  signPayload,
  toUnits,
  verifySignature,
} from "../lib.mjs";

const invoice = (over = {}) => ({
  id: "inv",
  decimals: 18,
  amount: "5",
  status: "watching",
  baselineUnits: "0",
  ...over,
});

test("a pre-funded address does NOT confirm an invoice nobody paid", () => {
  // The address already holds 1000 STRK, because it needed gas to deploy or
  // the merchant reused it. Before the fix this went straight to paid.
  const inv = invoice({ baselineUnits: toUnits("1000", 18).toString() });
  assert.equal(evaluateInvoice(inv, toUnits("1000", 18)).status, "watching");
  assert.equal(evaluateInvoice(inv, toUnits("1004.999", 18)).status, "watching");

  const paid = evaluateInvoice(inv, toUnits("1005", 18));
  assert.equal(paid.status, "paid");
  assert.equal(paid.receivedUnits, toUnits("5", 18).toString());
});

test("an unrelated later withdrawal from the address cannot un-pay it", () => {
  const paid = evaluateInvoice(invoice(), toUnits("5", 18));
  assert.equal(paid.status, "paid");
  assert.equal(evaluateInvoice(paid, 0n).status, "paid");
});

test("a payment that landed beats an expiry evaluated afterwards", () => {
  // The payer settled before the deadline; the poll ran after it. Expiring
  // here strands their funds at an address nobody watches. It is recorded as
  // late rather than on time, so the merchant can apply their own policy, but
  // it is never recorded as unpaid.
  const inv = invoice({ expiresAt: 1_000 });
  const result = evaluateInvoice(inv, toUnits("5", 18), 9_999);
  assert.equal(result.status, "paid_late");
  assert.ok(SETTLED_STATES.has(result.status));
  assert.equal(result.receivedUnits, toUnits("5", 18).toString());
});

test("an invoice past its deadline with nothing received expires", () => {
  const inv = invoice({ expiresAt: 1_000 });
  assert.equal(evaluateInvoice(inv, 0n, 9_999).status, "expired");
});

test("money at the address past the deadline is underpaid, never expired", () => {
  // "expired" invited the dashboard's delete button, which frees the address
  // for reuse: a later invoice would then settle on this payer's stranded 1 STRK.
  const inv = invoice({ expiresAt: 1_000 });
  const result = evaluateInvoice(inv, toUnits("1", 18), 9_999);
  assert.equal(result.status, "underpaid");
  assert.equal(result.receivedUnits, toUnits("1", 18).toString());
  assert.equal(result.shortfallUnits, toUnits("4", 18).toString());
  assert.ok(!DELETABLE_STATES.has(result.status), "an address holding money must not be released");
  assert.ok(UNPAYABLE_STATES.has(result.status), "a payer must not be sent back to this link");
});

test("an underpaid invoice topped up inside the grace window settles", () => {
  const inv = invoice({ expiresAt: 1_000 });
  const short = evaluateInvoice(inv, toUnits("1", 18), 9_999);
  const settled = evaluateInvoice(short, toUnits("5", 18), 20_000);
  assert.equal(settled.status, "paid_late");
  assert.equal(settled.receivedUnits, toUnits("5", 18).toString());
});

test("the grace window ends, and then nothing is polled or re-judged", () => {
  const inv = invoice({ expiresAt: 1_000 });
  const short = evaluateInvoice(inv, toUnits("1", 18), 9_999);
  const tooLate = short.expiredAt + LATE_GRACE_MS + 1;
  assert.equal(shouldPoll(short, tooLate), false);
  assert.equal(evaluateInvoice(short, toUnits("5", 18), tooLate).status, "underpaid");
});

test("settled invoices are never polled again", () => {
  const paid = evaluateInvoice(invoice(), toUnits("5", 18));
  assert.equal(shouldPoll(paid), false);
  assert.equal(shouldPoll(invoice({ status: "reserving" })), false);
  assert.equal(shouldPoll(invoice({ status: "needs_reregistration" })), false);
  assert.equal(shouldPoll(invoice()), true);
});

test("overpayment is reported, not quietly kept", () => {
  const over = evaluateInvoice(invoice(), toUnits("7.5", 18));
  assert.equal(over.status, "paid");
  assert.equal(over.overpaidUnits, toUnits("2.5", 18).toString());
  // An exact payment must not claim an overpayment of zero.
  assert.equal(evaluateInvoice(invoice(), toUnits("5", 18)).overpaidUnits, undefined);
});

test("partial payment before the deadline keeps watching and shows progress", () => {
  const inv = invoice({ expiresAt: 9_999_999 });
  const partial = evaluateInvoice(inv, toUnits("2", 18), 1_000);
  assert.equal(partial.status, "watching");
  assert.equal(partial.receivedUnits, toUnits("2", 18).toString());
  // Same balance again is not news: returning a new object every poll would
  // rewrite the store forever.
  assert.equal(evaluateInvoice(partial, toUnits("2", 18), 1_001), partial);
});

test("the two state sets answer different questions and must not be merged", () => {
  // Every deletable state is unpayable, but not the reverse: underpaid and
  // paid rows are unpayable AND must survive, because releasing their address
  // would let a later invoice settle on money that is already there.
  for (const s of DELETABLE_STATES) assert.ok(UNPAYABLE_STATES.has(s), `${s} should be unpayable`);
  assert.ok(UNPAYABLE_STATES.has("underpaid") && !DELETABLE_STATES.has("underpaid"));
  assert.ok(UNPAYABLE_STATES.has("paid") && !DELETABLE_STATES.has("paid"));
  assert.ok(UNPAYABLE_STATES.has("paid_late") && !DELETABLE_STATES.has("paid_late"));
});

test("a zero or empty amount cannot be satisfied by an empty address", () => {
  assert.throws(() => evaluateInvoice(invoice({ amount: "" }), 0n), /Invalid amount/);
  assert.throws(() => evaluateInvoice(invoice({ amount: "0.0.1" }), 0n), /Invalid amount/);
});

test("webhook signatures bind a timestamp, so a captured delivery expires", () => {
  const body = JSON.stringify({ event: "payment.confirmed", deliveryId: "dlv_1" });
  const now = 1_800_000_000;
  const sig = signPayload("whsec", body, now);

  assert.ok(verifySignature("whsec", body, sig, now, now));
  assert.ok(verifySignature("whsec", body, sig, now, now + 299), "inside the window");
  assert.ok(!verifySignature("whsec", body, sig, now, now + 301), "replayed later: rejected");
  assert.ok(!verifySignature("whsec", body, sig, now, now - 301), "clock far behind: rejected");
});

test("signatures still reject tampering, a wrong secret, and a missing timestamp", () => {
  const body = JSON.stringify({ amount: "5" });
  const now = 1_800_000_000;
  const sig = signPayload("whsec", body, now);
  assert.ok(!verifySignature("whsec", JSON.stringify({ amount: "500" }), sig, now, now));
  assert.ok(!verifySignature("other", body, sig, now, now));
  assert.ok(!verifySignature("whsec", body, sig, undefined, now));
  assert.ok(!verifySignature("whsec", body, "deadbeef", now, now));
});

test("signing without a timestamp is a programming error, not a silent downgrade", () => {
  assert.throws(() => signPayload("whsec", "{}"), /requires a timestamp/);
});

test("a row with no baseline is refused, not treated as baseline zero", () => {
  // Rows written before baselines existed. Defaulting them to zero silently
  // restores absolute-balance confirmation on every open invoice at upgrade.
  const legacy = { id: "legacy", decimals: 18, amount: "1", status: "watching" };
  assert.throws(() => evaluateInvoice(legacy, toUnits("1000", 18)), /no usable baseline/);
  assert.throws(() => evaluateInvoice({ ...legacy, baselineUnits: "" }, 10n ** 21n), /no usable baseline/);
  assert.throws(() => evaluateInvoice({ ...legacy, baselineUnits: null }, 10n ** 21n), /no usable baseline/);
  assert.throws(() => evaluateInvoice({ ...legacy, baselineUnits: 5 }, 10n ** 21n), /no usable baseline/);
});

test("an invoice for zero can never be satisfied", () => {
  const inv = invoice({ amount: "0", baselineUnits: "0" });
  assert.throws(() => evaluateInvoice(inv, 0n), /non-positive amount/);
  assert.throws(() => evaluateInvoice(invoice({ amount: "0.0" }), 0n), /non-positive amount/);
});

test("an empty secret verifies nothing", () => {
  const body = "{}";
  const ts = Math.floor(Date.now() / 1000);
  assert.ok(!verifySignature("", body, signPayload("x", body, ts), ts));
  assert.ok(!verifySignature(undefined, body, "aa", ts));
});

test("restore and evaluate agree on what a usable baseline is", () => {
  // These drifted apart once: the number 0 passed the restorer's String()
  // test and failed the evaluator's, so the row was watched forever while
  // every poll threw.
  for (const bad of [undefined, null, "", "   ", 0, 5, [5], ["5"], {}, true, "0x10", "-1", "1e3", "1.0"]) {
    assert.equal(hasUsableBaseline({ baselineUnits: bad }), false, `${JSON.stringify(bad)} must be unusable`);
    assert.throws(() => evaluateInvoice({ ...invoice(), baselineUnits: bad }, 10n ** 24n), /no usable baseline/);
  }
  for (const good of ["0", "007", "1000000000000000000000000"]) {
    assert.equal(hasUsableBaseline({ baselineUnits: good }), true);
  }
});

test("addresses compare by value, not by spelling", () => {
  assert.ok(sameAddress("0xabc", "0x0ABC"));
  assert.ok(sameAddress("0x000000abc", "0xabc"));
  assert.ok(!sameAddress("0xabc", "0xabd"));
  assert.ok(!sameAddress("not-hex", "0xabc"));
  assert.ok(!sameAddress(undefined, "0xabc"));
});

test("sweeping an underpaid address does not turn it back into expired", () => {
  // "expired" is deletable, and deleting releases the address for reuse. A
  // merchant moving the partial payment out of the address must not be able to
  // erase the record that a payer sent it.
  const inv = invoice({ expiresAt: 1_000 });
  const under = evaluateInvoice(inv, toUnits("1", 18), 9_999);
  assert.equal(under.status, "underpaid");

  const swept = evaluateInvoice(under, 0n, 10_000);
  assert.equal(swept.status, "underpaid", "a swept address must stay underpaid");
  assert.equal(swept.receivedUnits, toUnits("1", 18).toString(), "the high-water mark survives the sweep");
  assert.ok(!DELETABLE_STATES.has(swept.status));
});

test("a balance that falls before the deadline never erases recorded progress", () => {
  const inv = invoice({ expiresAt: 9_999_999 });
  const partial = evaluateInvoice(inv, toUnits("3", 18), 1_000);
  assert.equal(partial.receivedUnits, toUnits("3", 18).toString());

  const dropped = evaluateInvoice(partial, toUnits("1", 18), 1_001);
  assert.equal(dropped.status, "watching");
  assert.equal(dropped.receivedUnits, toUnits("3", 18).toString(), "the high-water mark holds");
  // And an unchanged high-water mark must not rewrite the row every poll.
  assert.equal(evaluateInvoice(dropped, toUnits("1", 18), 1_002), dropped);
});

test("an underpaid row at an unchanged level is not rewritten every poll", () => {
  const inv = invoice({ expiresAt: 1_000 });
  const under = evaluateInvoice(inv, toUnits("2", 18), 9_999);
  const again = evaluateInvoice(under, toUnits("2", 18), 10_000);
  assert.equal(again, under, "same object: nothing changed, so nothing is persisted");
  // expiredAt must be the moment it expired, not the moment of the last poll.
  assert.equal(under.expiredAt, 9_999);
  assert.equal(evaluateInvoice(under, toUnits("4", 18), 20_000).expiredAt, 9_999);
});
