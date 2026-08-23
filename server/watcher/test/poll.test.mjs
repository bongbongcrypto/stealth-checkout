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
  layout: "keys", // or "data": the older Cairo-0 event shape
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
          // A node cannot filter on keys a data-borne token does not emit, so
          // in that layout it returns everything and the reader must sort it out.
          .filter((t) => (chain.layout === "data" || !wantTo ? true : t.to === BigInt(wantTo)))
          .filter((t) => (chain.layout === "data" || !wantFrom ? true : t.from === BigInt(wantFrom)))
          .map((t) =>
            chain.layout === "data"
              ? {
                  // Cairo-0 style: from and to travel in data, not keys.
                  keys: [TRANSFER],
                  data: [
                    "0x" + t.from.toString(16),
                    "0x" + t.to.toString(16),
                    "0x" + t.amount.toString(16),
                    "0x0",
                  ],
                  transaction_hash: "0x0feed",
                  block_number: t.block,
                }
              : {
                  keys: [TRANSFER, "0x" + t.from.toString(16), "0x" + t.to.toString(16)],
                  data: ["0x" + t.amount.toString(16), "0x0"],
                  transaction_hash: "0x0feed",
                  block_number: t.block,
                },
          );
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

test("a data-borne token's outflow is read, so a swept payment is not lost", () => {
  // The inbound scan read both event layouts; the outbound one read only the
  // keyed layout, added a round later. On a data-borne token every outflow
  // summed to zero, the credit cap collapsed to the bare balance delta, and a
  // payer's full payment - swept by the merchant - was recorded as never paid.
  // The invoice then expired and its address was RELEASED for reuse.
  chain.reset();
  chain.layout = "data"; // from/to live in data, not keys
  const addr = freshAddress();
  return (async () => {
    try {
      const inv = await createInvoice("5", addr, { expiresAt: Date.now() + 300 });
      chain.height = 1001;
      chain.credit(addr, units(5), 1001); // paid in full
      chain.sweep(addr, units(5), 1001); // and swept straight away

      await watcher.pollOnce();
      const row = watcher.invoices.get(inv.id);
      assert.equal(row.status, "paid", "the money arrived; the balance being zero again is the sweep");
      assert.equal(row.receivedUnits, units(5).toString());

      // And it must never become deletable.
      await new Promise((r) => setTimeout(r, 400));
      await watcher.pollOnce();
      const del = await fetch(`${base}/invoices/${inv.id}`, { method: "DELETE", headers: auth });
      assert.equal(del.status, 409, "a paid address must never be released");
    } finally {
      chain.layout = "keys";
    }
  })();
});

test("an address whose numbers do not reconcile is held open, not expired", () => {
  // Crediting the lower figure and letting the deadline expire the row
  // released an address a payer's money had genuinely reached.
  chain.reset();
  const addr = freshAddress();
  return (async () => {
    const inv = await createInvoice("5", addr, { expiresAt: Date.now() + 200 });
    // Inbound events say 5 arrived; the balance and the outbound events say
    // nothing did. Something is wrong, and it is not the payer's problem.
    chain.height = 1001;
    chain.transfers.push({ from: 1n, to: BigInt(addr), amount: units(5), block: 1001 });

    await new Promise((r) => setTimeout(r, 300));
    await watcher.pollOnce();
    const row = watcher.invoices.get(inv.id);
    assert.equal(row.status, "watching", "held, not expired on numbers we do not trust");
    const del = await fetch(`${base}/invoices/${inv.id}`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 409, "and not deletable while it is unresolved");
  })();
});

// ---------------------------------------------------------------------------
// Guards that protect real money and had no test: a round-6 mutation pass
// deleted each of these with the suite still green.
// ---------------------------------------------------------------------------

test("each event gets its own delivery id, so a dedupe cannot swallow one", async () => {
  // An invoice that went underpaid and was then topped up sent
  // payment.confirmed under the id its payment.underpaid had already used, and
  // every merchant deduping as the docs instruct discarded the confirmation:
  // money in, order never shipped.
  chain.reset();
  const inv = await createInvoice("5", freshAddress(), { expiresAt: Date.now() + 200 });
  const row = watcher.invoices.get(inv.id);

  watcher.queueWebhook(row, "payment.underpaid");
  const first = watcher.invoices.get(inv.id).webhook.deliveryId;
  watcher.queueWebhook(watcher.invoices.get(inv.id), "payment.confirmed");
  const second = watcher.invoices.get(inv.id).webhook.deliveryId;

  assert.ok(first && second);
  assert.notEqual(first, second, "a different event is a different delivery");
});

test("an Idempotency-Key cannot be reused for different terms", async () => {
  // Merchants key on their own order id. Returning the old row for a repriced
  // order would have them ship the new goods against the old invoice.
  chain.reset();
  const body = (amount, address) =>
    JSON.stringify({ token: "STRK", amount, receiveAddress: address });
  const key = { ...auth, "Idempotency-Key": "order-xyz" };
  const addrA = freshAddress();

  const first = await fetch(`${base}/invoices`, { method: "POST", headers: key, body: body("10", addrA) });
  assert.equal(first.status, 201);
  const firstId = (await first.json()).id;

  // Same key, same terms: the row it already made.
  const replay = await fetch(`${base}/invoices`, { method: "POST", headers: key, body: body("10", addrA) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, firstId);

  // Same key, DIFFERENT terms: refused, loudly.
  const repriced = await fetch(`${base}/invoices`, { method: "POST", headers: key, body: body("500", freshAddress()) });
  assert.equal(repriced.status, 409, "a key must name one request, not any request");
  assert.match((await repriced.json()).error, /already used for a different invoice/);
});

test("holding an unreconciled row open never edits the row's own deadline", () => {
  // The hold used to be applied by passing a doctored copy with
  // `expiresAt: undefined`, and evaluateInvoice returns a spread of what it is
  // given - so the copy was written back and persisted. The merchant's
  // deadline was destroyed for good, and every later payment reported `paid`
  // where it should have said `paid_late`.
  chain.reset();
  const addr = freshAddress();
  return (async () => {
    const deadline = Date.now() + 200;
    const inv = await createInvoice("5", addr, { expiresAt: deadline });

    // Inbound events claim money the balance and outbound events do not show.
    chain.height = 1001;
    chain.transfers.push({ from: 1n, to: BigInt(addr), amount: units(5), block: 1001 });
    await new Promise((r) => setTimeout(r, 300));
    await watcher.pollOnce();

    const held = watcher.invoices.get(inv.id);
    assert.equal(held.status, "watching", "held rather than expired");
    assert.equal(held.expiresAt, deadline, "and its deadline is untouched");

    const pub = await (await fetch(`${base}/public/invoices/${inv.id}?to=${addr}`)).json();
    assert.equal(pub.expiresAt, deadline, "including as the payer's page sees it");
  })();
});

test("a late payment is still recorded as late after a row has been held", () => {
  chain.reset();
  const addr = freshAddress();
  return (async () => {
    const inv = await createInvoice("5", addr, { expiresAt: Date.now() + 150 });
    chain.height = 1001;
    // A phantom inbound event: more in than the balance and the outbound
    // events can account for, so the row is held rather than expired.
    const phantom = { from: 1n, to: BigInt(addr), amount: units(5), block: 1001 };
    chain.transfers.push(phantom);
    await new Promise((r) => setTimeout(r, 250));
    await watcher.pollOnce();
    assert.equal(watcher.invoices.get(inv.id).status, "watching", "held, not expired");

    // The discrepancy resolves - the node had been serving a stale view - and
    // the money is genuinely there, after the deadline.
    chain.transfers.splice(chain.transfers.indexOf(phantom), 1);
    chain.credit(addr, units(5), 1002);
    chain.height = 1002;
    await watcher.pollOnce();
    assert.equal(
      watcher.invoices.get(inv.id).status,
      "paid_late",
      "a destroyed deadline would have reported this as on time",
    );
  })();
});

test("a dust-locked invoice can be written off, and keeps its address forever", () => {
  // Anyone who has seen a link can send 1 wei and pin the invoice: not
  // deletable, not cancellable, address never reusable. There has to be a way
  // out that does not release the address.
  chain.reset();
  const addr = freshAddress();
  return (async () => {
    const inv = await createInvoice("5", addr, { expiresAt: Date.now() + 150 });
    chain.height = 1001;
    chain.credit(addr, 1n, 1001); // one wei, from a stranger
    await new Promise((r) => setTimeout(r, 250));
    await watcher.pollOnce();
    assert.equal(watcher.invoices.get(inv.id).status, "underpaid");

    assert.equal((await fetch(`${base}/invoices/${inv.id}`, { method: "DELETE", headers: auth })).status, 409);
    assert.equal((await fetch(`${base}/invoices/${inv.id}/cancel`, { method: "POST", headers: auth })).status, 409);

    const off = await fetch(`${base}/invoices/${inv.id}/write-off`, { method: "POST", headers: auth });
    assert.equal(off.status, 200);
    assert.equal(watcher.invoices.get(inv.id).status, "written_off");

    // The address stays claimed: the wei is still there.
    const reuse = await fetch(`${base}/invoices`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ token: "STRK", amount: "5", receiveAddress: addr }),
    });
    assert.equal(reuse.status, 400);
    assert.equal((await fetch(`${base}/invoices/${inv.id}`, { method: "DELETE", headers: auth })).status, 409);
  })();
});

test("write-off refuses a settled invoice, and needs the token", async () => {
  chain.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);
  chain.height = 1001;
  chain.credit(addr, units(5), 1001);
  await watcher.pollOnce();
  assert.equal(watcher.invoices.get(inv.id).status, "paid");

  const res = await fetch(`${base}/invoices/${inv.id}/write-off`, { method: "POST", headers: auth });
  assert.equal(res.status, 409, "there is nothing to write off");
  assert.equal((await fetch(`${base}/invoices/${inv.id}/write-off`, { method: "POST" })).status, 401);
});

test("a known token label must carry that token's address", () => {
  // The mirror of the check that already refused a known ADDRESS with the
  // wrong label. Without it, an invoice watched some other contract while the
  // payer's page, the webhook and the CSV all said STRK.
  return (async () => {
    const res = await fetch(`${base}/invoices`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        token: "STRK",
        tokenAddress: "0x0deadbeef0000000000000000000000000000000000000000000000000000001",
        decimals: 18,
        amount: "5",
        receiveAddress: freshAddress(),
      }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /STRK is 0x/);
  })();
});

test("an idempotent retry survives a recomputed deadline", () => {
  // A dashboard mints `now + N hours` on every click. Including that in the
  // fingerprint made every retry a different request, so the merchant got a
  // 409 forever for a create that had already succeeded - the exact failure
  // the feature exists to remove.
  return (async () => {
    const addr = freshAddress();
    const headers = { ...auth, "Idempotency-Key": `deadline-${addr}` };
    const body = () =>
      JSON.stringify({ token: "STRK", amount: "5", receiveAddress: addr, expiresAt: Date.now() + 3_600_000 });

    const first = await fetch(`${base}/invoices`, { method: "POST", headers, body: body() });
    assert.equal(first.status, 201);
    await new Promise((r) => setTimeout(r, 5));
    const retry = await fetch(`${base}/invoices`, { method: "POST", headers, body: body() });
    assert.equal(retry.status, 200, "a few milliseconds of deadline drift is the same request");
    assert.equal((await retry.json()).id, (await first.json()).id);
  })();
});
