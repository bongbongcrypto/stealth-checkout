// How much money a payer sent is decided by `totalReceived` / `totalSent`, and
// a mutation pass found every one of their ten guards deletable with the whole
// suite still green: pagination, repeated cursors, truncated scans, unreadable
// pages, the missing start block, and the credibility cap.
//
// These drive the real watcher against a node that misbehaves in each of those
// specific ways. Each test is written to fail if its guard is removed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "acct-token";
const TRANSFER = "0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
const units = (n) => BigInt(Math.round(n * 1000)) * 10n ** 15n;

/**
 * A node we can make behave badly on purpose: paginate, repeat a cursor,
 * paginate without end, corrupt a page, or lie about the block height.
 */
const node = {
  height: 1000,
  balances: new Map(),
  transfers: [],
  pageSize: 1000, // no pagination unless a test asks for it
  repeatOnce: false, // serve one page twice, then carry on
  repeated: false,
  endlessPages: false,
  corruptFor: null, // corrupt the scan for this address only
  reset() {
    this.height = 1000;
    this.balances = new Map();
    this.transfers = [];
    this.pageSize = 1000;
    this.repeatOnce = false;
    this.repeated = false;
    this.endlessPages = false;
    this.corruptFor = null;
  },
  credit(addr, amount, block = this.height) {
    const k = BigInt(addr).toString();
    this.balances.set(k, (this.balances.get(k) ?? 0n) + amount);
    this.transfers.push({ from: 1n, to: BigInt(addr), amount, block });
  },
  sweep(addr, amount, block = this.height) {
    const k = BigInt(addr).toString();
    this.balances.set(k, (this.balances.get(k) ?? 0n) - amount);
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
      let result;
      if (body.method === "starknet_blockNumber") result = node.height;
      else if (body.method === "starknet_call") {
        const bal = node.balanceOf(body.params[0].calldata[0]);
        result = ["0x" + (bal & ((1n << 128n) - 1n)).toString(16), "0x" + (bal >> 128n).toString(16)];
      } else if (body.method === "starknet_getEvents") {
        const f = body.params[0];
        const from = f.from_block.block_number;
        const wantTo = f.keys[2]?.[0];
        const wantFrom = f.keys[1]?.[0];
        const all = node.transfers
          .filter((t) => t.block >= from)
          .filter((t) => (wantTo ? t.to === BigInt(wantTo) : true))
          .filter((t) => (wantFrom ? t.from === BigInt(wantFrom) : true));

        const cursor = Number(f.continuation_token ?? 0);
        const page = all.slice(cursor, cursor + node.pageSize);
        // Corrupt only the scan for the address the test named, so an earlier
        // invoice's poll cannot consume the page this test is aiming at.
        // The FIRST page only. Corrupting every page made the sum zero either
        // way, so the test could not tell the two behaviours apart.
        const corrupt =
          node.corruptFor !== null &&
          wantTo !== undefined &&
          cursor === 0 &&
          BigInt(wantTo) === BigInt(node.corruptFor);
        const events = page.map((t, i) => ({
          keys: [TRANSFER, "0x" + t.from.toString(16), "0x" + t.to.toString(16)],
          data: corrupt && i === 0 ? ["nonsense"] : ["0x" + t.amount.toString(16), "0x0"],
          transaction_hash: "0x0feed",
          block_number: t.block,
        }));
        const next = cursor + node.pageSize;
        result = { events };
        if (node.endlessPages) result.continuation_token = String(next);
        else if (node.repeatOnce && cursor > 0 && !node.repeated) {
          node.repeated = true;
          result.continuation_token = String(cursor); // hand back the same page once
        } else if (next < all.length) result.continuation_token = String(next);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));

  process.env.WATCHER_RPC = `http://127.0.0.1:${rpc.address().port}`;
  process.env.WATCHER_TOKEN = TOKEN;
  process.env.WATCHER_STORE = join(tmpdir(), `spay-acct-${process.pid}.json`);
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
const freshAddress = () => "0x0" + (0x2000 + ++seq).toString(16).padStart(62, "0");

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

test("a payment split across several pages is summed, not truncated", async () => {
  node.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);
  node.height = 1001;
  for (let i = 0; i < 5; i++) node.credit(addr, units(1), 1001); // 5 x 1 STRK
  node.pageSize = 1; // one transfer per page

  await watcher.pollOnce();
  const row = watcher.invoices.get(inv.id);
  assert.equal(row.status, "paid", "all five pages must be read");
  assert.equal(row.receivedUnits, units(5).toString());
});

test("a node that repeats its cursor cannot double-count a payment", async () => {
  // Counting one page twice would credit 5 for a 4 STRK payment. The address
  // is swept, so only the event sum can decide - the balance delta cannot
  // quietly give the right answer and hide the bug.
  node.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);
  node.height = 1001;
  for (let i = 0; i < 4; i++) node.credit(addr, units(1), 1001); // 4 of the 5 owed
  node.sweep(addr, units(4), 1001);
  node.pageSize = 1;
  node.repeatOnce = true;

  await watcher.pollOnce();
  assert.equal(watcher.invoices.get(inv.id).status, "watching", "4 STRK cannot settle a 5 STRK invoice");
});

test("a scan truncated at the page cap is refused, not reported as the total", async () => {
  // 60 transfers of 1 STRK, one per page, against a 55 STRK invoice. Stopping
  // at the 50-page cap and returning that partial sum would under-credit the
  // payer by 10 STRK and leave a fully paid invoice unpaid.
  node.reset();
  const addr = freshAddress();
  const inv = await createInvoice("55", addr);
  node.height = 1001;
  for (let i = 0; i < 60; i++) node.credit(addr, units(1), 1001);
  node.pageSize = 1;

  await watcher.pollOnce();
  const row = watcher.invoices.get(inv.id);
  assert.equal(row.status, "paid", "the truncated sum must not be believed; the balance delta answers correctly");
  assert.equal(row.receivedUnits, units(60).toString());
});

test("an unreadable page aborts the scan rather than crediting what it could read", async () => {
  // One page cannot be read, a later one carries real money, and the address
  // was swept so only events can see any of it. Skipping the bad page and
  // trusting the rest credits a figure nothing verified; refusing is the only
  // honest answer, and it leaves the row open for a human to look at.
  node.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);
  node.height = 1001;
  node.credit(addr, units(2), 1001); // page 1: the one made unreadable
  node.credit(addr, units(5), 1001); // page 2: readable, and enough on its own
  node.sweep(addr, units(7), 1001);
  node.pageSize = 1;
  node.corruptFor = addr;

  await watcher.pollOnce();
  const row = watcher.invoices.get(inv.id);
  // With the scan refused there is no credible figure, so the row is held
  // rather than being written off as unpaid.
  assert.notEqual(row.status, "paid", "an unreadable scan is not evidence of payment");
  assert.ok(["watching"].includes(row.status), `held, got ${row.status}`);
});

test("credit never exceeds what the chain can account for", async () => {
  // inflow > balance growth + outflow means the two measurements disagree.
  // Believing the larger confirms an invoice on money that was already there.
  node.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);
  node.height = 1001;
  // A phantom inbound event with no matching balance change and no outflow.
  node.transfers.push({ from: 1n, to: BigInt(addr), amount: units(5), block: 1001 });

  await watcher.pollOnce();
  assert.equal(watcher.invoices.get(inv.id).status, "watching", "unreconciled numbers cannot confirm");
});

test("a swept payment is still credited, because the outflow is counted", async () => {
  node.reset();
  const addr = freshAddress();
  const inv = await createInvoice("5", addr);
  node.height = 1001;
  node.credit(addr, units(5), 1001);
  node.sweep(addr, units(5), 1001);

  await watcher.pollOnce();
  const row = watcher.invoices.get(inv.id);
  assert.equal(row.status, "paid", "the balance is back to zero; the money still arrived");
  assert.equal(row.receivedUnits, units(5).toString());
});

test("the outflow scan counts only transfers FROM this address", async () => {
  // Counting every Transfer as an outflow inflates the cap that bounds an
  // over-credit, so the phantom-event case above stops being caught.
  node.reset();
  const addr = freshAddress();
  const other = freshAddress();
  const inv = await createInvoice("5", addr);
  node.height = 1001;
  node.transfers.push({ from: 1n, to: BigInt(addr), amount: units(5), block: 1001 }); // phantom in
  node.sweep(other, units(50), 1001); // a large outflow from someone else

  await watcher.pollOnce();
  assert.equal(
    watcher.invoices.get(inv.id).status,
    "watching",
    "another address's outflow must not widen this invoice's credibility cap",
  );
});
