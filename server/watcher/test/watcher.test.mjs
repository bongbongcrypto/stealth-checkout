import { test } from "node:test";
import assert from "node:assert/strict";
import {
  balanceOfRequest,
  evaluateInvoice,
  normFelt,
  signPayload,
  toUnits,
  transferEventsRequest,
  txHashFromEvents,
  u256FromCallResult,
  verifySignature,
} from "../lib.mjs";

const baseInvoice = {
  id: "inv_test",
  token: "STRK",
  decimals: 18,
  amount: "1.5",
  receiveAddress: "0x0abc",
  status: "watching",
};

test("toUnits: decimal strings to integer units, no floats", () => {
  assert.equal(toUnits("1", 18), 10n ** 18n);
  assert.equal(toUnits("1.5", 18), 15n * 10n ** 17n);
  assert.equal(toUnits("0.000001", 6), 1n);
  assert.throws(() => toUnits("1.2345678", 6), /Invalid amount/);
  assert.throws(() => toUnits("abc", 18), /Invalid amount/);
});

test("u256FromCallResult combines low and high felts", () => {
  assert.equal(u256FromCallResult(["0x5"]), 5n);
  assert.equal(u256FromCallResult(["0x0", "0x1"]), 1n << 128n);
  assert.throws(() => u256FromCallResult([]), /Empty/);
});

test("evaluateInvoice: pays only at or above the invoiced amount", () => {
  const under = evaluateInvoice(baseInvoice, toUnits("1.499999", 18));
  assert.equal(under.status, "watching");
  const exact = evaluateInvoice(baseInvoice, toUnits("1.5", 18));
  assert.equal(exact.status, "paid");
  assert.ok(exact.confirmedAt);
  const over = evaluateInvoice(baseInvoice, toUnits("2", 18));
  assert.equal(over.status, "paid");
});

test("evaluateInvoice: expiry wins over a later payment, paid is terminal", () => {
  const now = 1_000_000;
  const expired = evaluateInvoice({ ...baseInvoice, expiresAt: now - 1 }, 0n, now);
  assert.equal(expired.status, "expired");
  const stillPaid = evaluateInvoice({ ...baseInvoice, status: "paid" }, 0n, now);
  assert.equal(stillPaid.status, "paid");
});

test("webhook signatures round-trip and reject tampering", () => {
  // Signatures now cover `timestamp.body`; replay windows live in security.test.mjs.
  const body = JSON.stringify({ event: "payment.confirmed", invoice: { id: "inv_test" } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = signPayload("whsec_secret", body, ts);
  assert.ok(verifySignature("whsec_secret", body, sig, ts));
  assert.ok(!verifySignature("whsec_secret", body + " ", sig, ts));
  assert.ok(!verifySignature("whsec_other", body, sig, ts));
  assert.ok(!verifySignature("whsec_secret", body, "deadbeef", ts));
});

test("balanceOf request shape targets the holder at latest block", () => {
  const req = balanceOfRequest("0x0token", "0x0holder", 7);
  assert.equal(req.method, "starknet_call");
  assert.equal(req.params[0].calldata[0], "0x0holder");
  assert.equal(req.params[1], "latest");
});

test("transfer events request filters selector and recipient", () => {
  const req = transferEventsRequest("0x0token", "0x00abc", 123);
  const [selector, from, to] = req.params[0].keys;
  assert.equal(from.length, 0);
  assert.equal(to[0], normFelt("0x00abc"));
  assert.ok(selector[0].startsWith("0x0099cd8bde"));
});

test("txHashFromEvents matches keyed and data-borne recipients, else undefined", () => {
  const keyed = {
    events: [{ transaction_hash: "0xaaa", keys: ["0xsel", "0x1", "0x0abc"], data: ["0x5", "0x0"] }],
  };
  assert.equal(txHashFromEvents(keyed, "0xabc"), "0xaaa");
  const dataBorne = {
    events: [{ transaction_hash: "0xbbb", keys: ["0xsel"], data: ["0x1", "0x0abc", "0x5", "0x0"] }],
  };
  assert.equal(txHashFromEvents(dataBorne, "0xabc"), "0xbbb");
  assert.equal(txHashFromEvents({ events: [] }, "0xabc"), undefined);
});
