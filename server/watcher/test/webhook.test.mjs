// WEBHOOK_URL and WEBHOOK_SECRET are read into module constants at import, so
// these need their own file with the environment set first. A test that sets
// them afterwards asserts nothing: an earlier version of this one "passed"
// because no webhook could have been sent either way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

let sink, received, watcher, lib;

before(async () => {
  received = [];
  sink = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: raw });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((r) => sink.listen(0, "127.0.0.1", r));

  process.env.WEBHOOK_URL = `http://127.0.0.1:${sink.address().port}/hook`;
  process.env.WEBHOOK_SECRET = ""; // the merchant forgot to set it
  process.env.WATCHER_TOKEN = "wh-token";
  process.env.WATCHER_RPC = "http://127.0.0.1:1";
  process.env.WATCHER_STORE = join(tmpdir(), `spay-wh-${process.pid}.json`);
  watcher = await import("../watcher.mjs");
  lib = await import("../lib.mjs");
});

after(() => sink?.close());

const row = () => ({
  id: "wh1",
  token: "STRK",
  amount: "5",
  status: "paid",
  decimals: 18,
  receiveAddress: "0x0abc",
  baselineUnits: "0",
  createdAt: Date.now(),
});

test("nothing goes out unsigned when the secret is missing", async () => {
  // Sending HMAC'd with an empty key is forgeable by anyone who can reach the
  // merchant's endpoint. Refusing is the only safe answer; downgrading
  // silently would look like it worked.
  const inv = row();
  watcher.invoices.set(inv.id, inv);
  watcher.queueWebhook(inv, "payment.confirmed");
  await watcher.deliverWebhook(watcher.invoices.get(inv.id));

  assert.equal(received.length, 0, "the endpoint must not have been called at all");
  assert.equal(watcher.invoices.get(inv.id).webhook.deliveredAt, undefined, "and it is not marked delivered");
});

test("a forged signature made with the empty secret is refused by the verifier", () => {
  // The other half of fail-closed: even if something did send, a merchant
  // whose own secret is unset must not accept it.
  const body = '{"event":"payment.confirmed"}';
  const ts = Math.floor(Date.now() / 1000);
  assert.ok(!lib.verifySignature("", body, lib.signPayload("", body, ts), ts));
});
