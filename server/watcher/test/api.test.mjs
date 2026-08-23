// The HTTP surface had zero tests while carrying the worst defects: no auth,
// wildcard CORS, and a caller-chosen webhook URL that turned the merchant's
// secret into a signing oracle. These drive the real server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const TOKEN = "test-token";
const ORIGIN = "https://dashboard.example";
let rpc, base, makeServer, server;

before(async () => {
  // A fake RPC so the watcher can read baselines without touching mainnet.
  rpc = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ["0x0", "0x0"] }));
    });
  });
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));

  process.env.WATCHER_RPC = `http://127.0.0.1:${rpc.address().port}`;
  process.env.WATCHER_TOKEN = TOKEN;
  process.env.WATCHER_ORIGIN = ORIGIN;
  process.env.WATCHER_STORE = `${process.env.TEMP || "/tmp"}/spay-api-test-${Date.now()}.json`;
  ({ makeServer } = await import("../watcher.mjs"));

  server = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rpc?.close();
});

const call = (path, opts = {}) =>
  fetch(base + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });

const auth = { Authorization: `Bearer ${TOKEN}` };

test("the ledger is not readable without a token", async () => {
  const res = await call("/invoices");
  assert.equal(res.status, 401);
});

test("a wrong token is rejected", async () => {
  const res = await call("/invoices", { headers: { Authorization: "Bearer nope" } });
  assert.equal(res.status, 401);
});

test("an unknown origin gets no CORS grant, so a random page cannot read it", async () => {
  const res = await call("/invoices", { headers: { ...auth, Origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  const pre = await call("/invoices", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
});

test("the configured dashboard origin is allowed, and only that one", async () => {
  const res = await call("/invoices", { headers: { ...auth, Origin: ORIGIN } });
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(res.headers.get("vary"), "Origin");
});

test("an invoice cannot name its own webhook URL (no signing oracle)", async () => {
  const res = await call("/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      id: "oracle-attempt",
      token: "STRK",
      amount: "5",
      receiveAddress: "0x0123456789abcdef",
      webhookUrl: "http://attacker.example/collect",
    }),
  });
  assert.equal(res.status, 201);
  const inv = await res.json();
  assert.equal(inv.webhookUrl, undefined, "caller-supplied webhook URL must be dropped");
});

test("a registered invoice records the baseline it will measure against", async () => {
  const res = await call("/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: "with-baseline", token: "STRK", amount: "2", receiveAddress: "0x0abc123456789" }),
  });
  const inv = await res.json();
  assert.equal(inv.status, "watching");
  assert.equal(typeof inv.baselineUnits, "string");
});

test("two invoices cannot share a receive address", async () => {
  const body = (id) =>
    JSON.stringify({ id, token: "STRK", amount: "1", receiveAddress: "0x0deadbeef12345" });
  assert.equal((await call("/invoices", { method: "POST", headers: auth, body: body("share-a") })).status, 201);
  const second = await call("/invoices", { method: "POST", headers: auth, body: body("share-b") });
  assert.equal(second.status, 400);
  assert.match((await second.json()).error, /already used/);
});

test("an address is never reused, whatever state its invoice reached", async () => {
  // A late payment against a dead invoice would otherwise settle its successor
  // at the same address. The guard scans every row regardless of status, so
  // drive the row through each terminal state and re-check.
  const addr = "0x0aabbccddeeff01";
  const first = await call("/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: "expire-me", token: "STRK", amount: "1", receiveAddress: addr, expiresAt: Date.now() + 3_600_000 }),
  });
  assert.equal(first.status, 201);

  const { invoices } = await import("../watcher.mjs");
  for (const status of ["watching", "expired", "underpaid", "paid", "paid_late"]) {
    invoices.set("expire-me", { ...invoices.get("expire-me"), status });
    const reuse = await call("/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: `successor-${status}`, token: "STRK", amount: "1", receiveAddress: addr }),
    });
    assert.equal(reuse.status, 400, `reuse must be refused while the first row is ${status}`);
    assert.match((await reuse.json()).error, /already used/);
  }
});

test("a stuck row can be released, a settled one cannot", async () => {
  const res = await call("/invoices/does-not-exist", { method: "DELETE", headers: auth });
  assert.equal(res.status, 404);
  // A watching invoice must not be deletable: that would free its address.
  const live = await call("/invoices/with-baseline", { method: "DELETE", headers: auth });
  assert.equal(live.status, 409);
  assert.match((await live.json()).error, /only reserving, expired or needs_reregistration/);
});

test("declaring the wrong decimals for a known token is refused, whatever the label", async () => {
  const STRK_ADDR = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  for (const label of ["STRK", "strk", "Strk", " STRK", undefined, null]) {
    const res = await call("/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        ...(label === undefined ? {} : { token: label }),
        tokenAddress: STRK_ADDR,
        decimals: 6,
        amount: "1",
        receiveAddress: `0x0dec${Math.random().toString(16).slice(2, 10)}`,
      }),
    });
    assert.equal(res.status, 400, `label ${JSON.stringify(label)} must be refused`);
    assert.match((await res.json()).error, /has 18 decimals, not 6|token must be a string/);
  }
});

test("array and object values are refused rather than stringified", async () => {
  const bad = async (payload) => {
    const res = await call("/invoices", { method: "POST", headers: auth, body: JSON.stringify(payload) });
    assert.equal(res.status, 400, JSON.stringify(payload));
  };
  await bad({ token: "STRK", amount: "1", receiveAddress: ["0x0123456789ab"] });
  await bad({ token: ["STRK"], amount: "1", receiveAddress: "0x0123456789ab" });
  await bad({ token: "STRK", amount: "1", receiveAddress: "0x0123456789ab", expiresAt: [] });
  await bad({ token: "STRK", amount: "1", receiveAddress: "0x0123456789ab", expiresAt: true });
  await bad({ token: "STRK", amount: "1", receiveAddress: "0x0123456789ab", id: 42 });
});

test("malformed invoices are refused", async () => {
  const bad = async (payload, pattern) => {
    const res = await call("/invoices", { method: "POST", headers: auth, body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, pattern);
  };
  await bad({ token: "STRK", amount: "1", receiveAddress: "nope" }, /receiveAddress/);
  await bad({ token: "STRK", amount: "0", receiveAddress: "0x0123456789ab" }, /greater than zero/);
  await bad({ token: "STRK", amount: "1.2.3", receiveAddress: "0x0123456789ab" }, /Invalid amount/);
  await bad({ token: "STRK", amount: "", receiveAddress: "0x0123456789ab" }, /Invalid amount/);
  await bad({ token: "DOGE", amount: "1", receiveAddress: "0x0123456789ab" }, /Unknown token/);
  await bad(
    { tokenAddress: "0x0feed1234567", decimals: 200000000, amount: "1", receiveAddress: "0x0123456789ab" },
    /decimals must be an integer/,
  );
});

test("health needs no token and leaks nothing", async () => {
  const res = await call("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------------------------------------------------------------------------
// Routes added for the payer-facing page, reconciliation, and durable webhooks.
// ---------------------------------------------------------------------------

const ADDR_PUB = "0x0000000000000000000000000000000000000000000000000000000000000abc";

test("the payer route serves an invoice only to someone holding the link", async () => {
  const created = await (
    await call("/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "pubtest", token: "STRK", amount: "2", receiveAddress: ADDR_PUB }),
    })
  ).json();
  assert.equal(created.status, "watching");

  // The id alone is not enough: guessing ids must not enumerate the ledger.
  assert.equal((await call("/public/invoices/pubtest")).status, 404);
  assert.equal((await call("/public/invoices/pubtest?to=0x1234567890")).status, 404);

  const ok = await call(`/public/invoices/pubtest?to=${ADDR_PUB}`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.amount, "2");
  assert.equal(body.token, "STRK");
  // The payer gets terms, never the merchant's bookkeeping.
  assert.equal(body.baselineUnits, undefined);
  assert.equal(body.webhook, undefined);
});

test("the payer route matches addresses by value, not by spelling", async () => {
  // Same address, leading zeros stripped: the payer's link and the merchant's
  // record disagree on spelling constantly.
  const res = await call(`/public/invoices/pubtest?to=0x${BigInt(ADDR_PUB).toString(16)}`);
  assert.equal(res.status, 200);
});

test("the payer route is readable cross-origin, and carries no credentials", async () => {
  const res = await call(`/public/invoices/pubtest?to=${ADDR_PUB}`, {
    headers: { Origin: "https://bongbongcrypto.github.io" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  // The authenticated ledger must NOT have been opened up by that wildcard.
  const ledger = await call("/invoices", { headers: { ...auth, Origin: "https://bongbongcrypto.github.io" } });
  assert.equal(ledger.headers.get("access-control-allow-origin"), null);
});

test("a retried create with the same Idempotency-Key returns the first invoice", async () => {
  const body = JSON.stringify({
    token: "STRK",
    amount: "3",
    receiveAddress: "0x00000000000000000000000000000000000000000000000000000000000abcde",
  });
  const headers = { ...auth, "Idempotency-Key": "key-1" };
  const first = await call("/invoices", { method: "POST", headers, body });
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const retry = await call("/invoices", { method: "POST", headers, body });
  assert.equal(retry.status, 200, "a retry must not read as a failure");
  assert.equal((await retry.json()).id, firstBody.id);

  // Without the key, the same address is still refused: idempotency is opt-in,
  // and address reuse is never allowed by accident.
  const noKey = await call("/invoices", { method: "POST", headers: auth, body });
  assert.equal(noKey.status, 400);
});

test("CSV export quotes properly and cannot inject a spreadsheet formula", async () => {
  const { csvCell, invoicesCsv } = await import("../watcher.mjs");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("-cmd|calc"), "'-cmd|calc");
  assert.equal(csvCell(undefined), "");

  const res = await call("/invoices.csv", { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const text = await res.text();
  assert.match(text.split("\r\n")[0], /^id,status,token,amount,receiveAddress/);
  assert.match(text, /pubtest/);
});

test("CSV export needs the token like every other merchant route", async () => {
  assert.equal((await call("/invoices.csv")).status, 401);
});

test("a webhook that never delivered can be re-queued, and survives a restart", async () => {
  const { invoices, queueWebhook, drainWebhooks } = await import("../watcher.mjs");
  const inv = invoices.get("pubtest");
  queueWebhook(inv, "payment.confirmed");
  assert.equal(inv.webhook.attempts, 0);
  const firstDelivery = inv.webhook.deliveryId;

  // No WEBHOOK_URL configured here, so draining is a no-op: the queue must
  // still be sitting on the row, which is what makes it survive a restart.
  await drainWebhooks();
  assert.equal(invoices.get("pubtest").webhook.deliveryId, firstDelivery);

  const res = await call("/invoices/pubtest/redeliver", { method: "POST", headers: auth });
  assert.equal(res.status, 202);
  // Same delivery id across retries: merchants dedupe on it.
  assert.equal((await res.json()).deliveryId, firstDelivery);

  const missing = await call("/invoices/nosuch/redeliver", { method: "POST", headers: auth });
  assert.equal(missing.status, 404);
});

test("redeliver needs the token", async () => {
  assert.equal((await call("/invoices/pubtest/redeliver", { method: "POST" })).status, 401);
});

test("a deadline in the past is refused at creation, not at the next poll", async () => {
  const res = await call("/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      id: "past",
      token: "STRK",
      amount: "1",
      receiveAddress: "0x0111111111111111111111111111111111111111111111111111111111111111",
      // Seconds instead of milliseconds: the usual way to get here by accident.
      expiresAt: Math.floor(Date.now() / 1000),
    }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already past/);
});

test("a future deadline is accepted", async () => {
  const res = await call("/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      id: "future",
      token: "STRK",
      amount: "1",
      receiveAddress: "0x0222222222222222222222222222222222222222222222222222222222222222",
      expiresAt: Date.now() + 3_600_000,
    }),
  });
  assert.equal(res.status, 201);
});
