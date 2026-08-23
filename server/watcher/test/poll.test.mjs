// The poller, the event accounting, the cancel route and the Host guard all
// shipped with no coverage. A round-5 audit proved it by mutation: hard-coding
// `baseline = 0n`, deleting the Host guard, and stripping both cancel guards
// each left the whole suite green.
//
// These drive the real watcher against a scriptable fake RPC. Every test is
// written to fail if its guard is removed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "poll-token";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const TRANSFER = "0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
const units = (n) => BigInt(Math.round(n * 1000)) * 10n ** 15n;

/**
 * A chain we control completely: a block height, a balance per address, and a
 * transfer log. The watcher cannot tell it from a real node.
 */
const chain = {
  height: 1000,
  balances: new Map(),
  transfers: [], // {from, to, amount, block}
  asked: [], // every JSON-RPC body the watcher sent
  reset() {
    this.height = 1000;
    this.balances = new Map();
    this.transfers = [];
    this.asked = [];
  },
  credit(addr, amount, block = this.height) {
    const key = BigInt(addr).toString();
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
    this.transfers.push({ from: 1n, to: BigInt(addr), amount, block });
  },
  sweep(addr, amount, block = this.height) {
    const key = BigInt(addr).toString();
    this.balances.set(key, (this.balances.get(key) ?? 0n) - amount);
    this.transfers.push({ from: BigInt(addr), to: 2n, amount, block });
  },
  balanceOf(addr) {
    return this.balances.get(BigInt(addr).toString()) ?? 0n;
  },
};

let rpc, server, base, watcher;

before(async () => {
  rpc = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      chain.asked.push(body);
      let result;
      if (body.method === "starknet_blockNumber") {
        result = chain.height;
      } else if (body.method === "starknet_call") {
        const holder = body.params[0].calldata[0];
        const low = chain.balanceOf(holder) & ((1n << 128n) - 1n);
        const high = chain.balanceOf(holder) >> 128n;
        result = ["0x" + low.toString(16), "0x" + high.toString(16)];
      } else if (body.method === "starknet_getEvents") {
        const f = body.params[0];
        const from = f.from_block.block_number;
        const wantTo = f.keys[2]?.[0];
        const wantFrom = f.keys[1]?.[0];
        const events = chain.transfers
          .filter((t) => t.block >= from)
          .filter((t) => (wantTo ? t.to === BigInt(wantTo) : true))
          .filter((t) => (wantFrom ? t.from === BigInt(wantFrom) : true))
          .map((t) => ({
            keys: [TRANSFER, "0x" + t.from.toString(16), "0x" + t.to.toString(16)],
            data: ["0x" + t.amount.toString(16), "0x0"],
            transaction_hash: "0x0feed",
            block_number: t.block,
          }));
        result = { events };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));

  process.env.WATCHER_RPC = `http://127.0.0.1:${rpc.address().port}`;
  process.env.WATCHER_TOKEN = TOKEN;
  process.env.WATCHER_STORE = join(tmpdir(), `spay-poll-${process.pid}.json`);
  watcher = await import("../watcher.mjs");

  server = watcher.makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rpc?.close();
});

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
let seq = 0;
const freshAddress = () => "0x0" + (0x1000 + ++seq).toString(16).padStart(62, "0");

async function createInvoice(amount, address, extra = {}) {
  const res = await fetch(`${base}/invoices`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ token: "STRK", amount, receiveAddress: address, ...extra }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(body)}`);
  return body;
}

test("money that arrived BEFORE the invoice existed never confirms it", async () => {
  // The critical one. The baseline is read at `latest` and the block height in
  // a separate call; when the height came back lower, the event scan started
  // inside the range the baseline already covered and counted the same
  // transfer twice. `max(events, delta)` then let that win over a delta of 0.
  chain.reset();
  const addr = freshAddress();
  chain.credit(addr, units(5), 1000); // pre-funded, in the registration block

  const inv = await createInvoice("5", addr);
  assert.equal(inv.baselineUnits, units(5).toString(), "the baseline sees the pre-funding");

  await watcher.pollOnce();
  const after1 = watcher.invoices.get(inv.id);
  assert.equal(after1.status, "watching", "NOBODY PAID: this must not confirm");

  // Now someone actually pays, in a later block.
  chain.height = 1001;
  chain.credit(addr, units(5), 1001);
  await watcher.pollOnce();
  assert.equal(watcher.invoices.get(inv.id).status, "paid", "and a real payment does confirm");
});

test("a lagging block height cannot open a window into the baseline", async () => {
  chain.reset();
  const addr = freshAddress();
  chain.credit(addr, units(5), 1000);
  // The height replica is one block behind the balance replica.
  chain.height = 999;

  const inv = await createInvoice("5", addr);
  chain.height = 1000;
  await watcher.pollOnce();
  assert.equal(watcher.invoices.get(inv.id).status, "watching", "still nobody paid");
});

test("sweeping the address does not erase the payer's credit", async () => {
  chain.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);

  chain.height = 1001;
  chain.credit(addr, units(5), 1001); // the payer pays in full
  chain.sweep(addr, units(5), 1001); // and the merchant sweeps immediately

  await watcher.pollOnce();
  const row = watcher.invoices.get(inv.id);
  assert.equal(row.status, "paid", "the balance is back to zero, but the money did arrive");
  assert.equal(row.receivedUnits, units(5).toString());
});

test("a partial payment is underpaid, with its address held", async () => {
  chain.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr, { expiresAt: Date.now() + 400 });

  chain.height = 1001;
  chain.credit(addr, units(2), 1001);
  await watcher.pollOnce();
  assert.equal(watcher.invoices.get(inv.id).status, "watching", "not overdue yet");

  await new Promise((r) => setTimeout(r, 500));
  await watcher.pollOnce();
  const row = watcher.invoices.get(inv.id);
  assert.equal(row.status, "underpaid");
  assert.equal(row.shortfallUnits, units(3).toString());

  // The address must not be released.
  const del = await fetch(`${base}/invoices/${row.id}`, { method: "DELETE", headers: auth });
  assert.equal(del.status, 409, "an address holding money must not be freed");
});

test("cancel refuses when money is at the address, even before a poll sees it", async () => {
  // The guard read `receivedUnits`, which only a poll writes. Between the
  // payer's transfer landing and the next cycle it read zero and wrote the
  // money off into a state that is never polled again.
  chain.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);

  chain.height = 1001;
  chain.credit(addr, units(5), 1001); // paid, and NOT yet polled
  assert.equal(watcher.invoices.get(inv.id).receivedUnits, undefined, "no poll has run");

  const res = await fetch(`${base}/invoices/${inv.id}/cancel`, { method: "POST", headers: auth });
  assert.equal(res.status, 409, "the chain says there is money here");
  assert.match((await res.json()).error, /at its address/);
  assert.equal(watcher.invoices.get(inv.id).status, "watching");
});

test("cancel works on a genuinely empty invoice, and stops polling it", async () => {
  chain.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);

  const res = await fetch(`${base}/invoices/${inv.id}/cancel`, { method: "POST", headers: auth });
  assert.equal(res.status, 200);
  assert.equal(watcher.invoices.get(inv.id).status, "cancelled");

  // And a late payment does not resurrect it.
  chain.height = 1001;
  chain.credit(addr, units(5), 1001);
  await watcher.pollOnce();
  assert.equal(watcher.invoices.get(inv.id).status, "cancelled");

  // Its address stays claimed: money is at it now.
  const reuse = await fetch(`${base}/invoices`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ token: "STRK", amount: "5", receiveAddress: addr }),
  });
  assert.equal(reuse.status, 400);
});

test("cancel and delete need the token", async () => {
  const a = await fetch(`${base}/invoices/whatever/cancel`, { method: "POST" });
  assert.equal(a.status, 401);
  const b = await fetch(`${base}/invoices/whatever`, { method: "DELETE" });
  assert.equal(b.status, 401);
});

/**
 * A raw request, because fetch() refuses to let a caller set Host: it is a
 * forbidden header name, so a fetch-based test would silently send the real
 * one and pass no matter what the guard did.
 */
function rawGet(path, host) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.address().port, path, method: "GET", headers: { Host: host }, setHost: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("the API refuses a Host header it does not bind", async () => {
  // It listens on loopback, so any other hostname reaching it is DNS
  // rebinding: a page on the internet pointing its own domain at 127.0.0.1.
  for (const host of ["evil.example", "EVIL.EXAMPLE", "localhost.evil.example", "127.0.0.1.evil.example"]) {
    assert.equal(await rawGet("/healthz", host), 403, `${host} must be refused`);
  }
  // And the ones it does bind still work.
  for (const host of ["localhost", "127.0.0.1", "localhost:9999"]) {
    assert.equal(await rawGet("/healthz", host), 200, `${host} must be allowed`);
  }
  // An absent Host is HTTP/1.0 or a bare socket, not a browser: it cannot be a
  // rebinding attack, and refusing it would break plain health probes.
  assert.equal(await rawGet("/healthz", ""), 200);
});

test("the event scan starts AFTER the block the baseline was pinned to", () => {
  // Asserted directly, not just through an outcome. The excess-credit cap
  // happens to absorb this particular mistake, and a guard whose only proof is
  // another guard is how four rounds of fixes each broke the next thing.
  const addr = freshAddress();
  chain.reset();
  return (async () => {
    const inv = await createInvoice("5", addr);
    assert.equal(inv.createdBlock, 1000);
    chain.asked = [];
    chain.height = 1001;
    await watcher.pollOnce();

    // Only this invoice's scans: the poller sweeps every watching row, and
    // rows left by earlier tests have their own, different, start blocks.
    const mine = BigInt(addr);
    const scans = chain.asked
      .filter((b) => b.method === "starknet_getEvents")
      .filter((b) => (b.params[0].keys[2] ?? b.params[0].keys[1] ?? []).some((k) => BigInt(k) === mine));
    assert.ok(scans.length >= 1, "the poller scanned for this address");
    for (const s of scans) {
      assert.equal(
        s.params[0].from_block.block_number,
        inv.createdBlock + 1,
        "a scan starting at createdBlock counts the baseline block twice",
      );
    }
  })();
});

test("the baseline is pinned to a block, never read at 'latest'", () => {
  // The two used to be read in separate round trips with nothing tying them
  // together, so a lagging replica could answer one and not the other.
  chain.reset();
  const addr = freshAddress();
  return (async () => {
    chain.asked = [];
    const inv = await createInvoice("5", addr);
    const calls = chain.asked.filter((b) => b.method === "starknet_call");
    assert.ok(calls.length >= 1);
    const pinned = calls.some((c) => c.params[1] && c.params[1].block_number === inv.createdBlock);
    assert.ok(pinned, `the baseline call must name block ${inv.createdBlock}, got ${JSON.stringify(calls.map((c) => c.params[1]))}`);
  })();
});
