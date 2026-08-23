// Regression tests for the defects an adversarial audit found. Each one here
// corresponds to a way real money was lost or forged before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateInvoice, signPayload, toUnits, verifySignature } from "../lib.mjs";

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
  // here strands their funds at an address nobody watches.
  const inv = invoice({ expiresAt: 1_000 });
  const result = evaluateInvoice(inv, toUnits("5", 18), 9_999);
  assert.equal(result.status, "paid");
});

test("an unpaid invoice past its deadline still expires", () => {
  const inv = invoice({ expiresAt: 1_000 });
  assert.equal(evaluateInvoice(inv, toUnits("1", 18), 9_999).status, "expired");
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
