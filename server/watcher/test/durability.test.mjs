// The ledger is the only place an invoice id is mapped to an order. When the
// write to it failed, `persistNow` logged the failure and returned as though it
// had worked, so `POST /invoices` answered 201 for a row that existed in one
// process and nowhere else. The merchant files the order, the payer pays, the
// process restarts, and the money sits on an address nothing is watching.
//
// Two watchers are started here, one with a store it can write and one with a
// store it cannot, rather than stubbing the writer or adding a setter to the
// server for the benefit of a test. The failure being tested came from a real
// filesystem, so a real filesystem produces it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const TOKEN = "durable-token";
const address = (n) => `0x0${String(n).padStart(63, "0")}`;

let rpc, dir, healthy, broken;

/** A node that answers, so nothing fails here for a reason we are not testing. */
function fakeChain() {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const result =
        body.method === "starknet_blockNumber"
          ? 1000
          : body.method === "starknet_call"
            ? ["0x0", "0x0"]
            : { events: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
}

/**
 * A watcher with its own store path. The query string forces a fresh module
 * instance, because the path is read once at import.
 */
async function startWatcher(storePath, tag) {
  process.env.WATCHER_RPC = `http://127.0.0.1:${rpc.address().port}`;
  process.env.WATCHER_TOKEN = TOKEN;
  process.env.WATCHER_STORE = storePath;
  const mod = await import(`../watcher.mjs?durability=${tag}`);
  const server = mod.makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { mod, server, base: `http://127.0.0.1:${server.address().port}`, storePath };
}

before(async () => {
  rpc = fakeChain();
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
  dir = mkdtempSync(join(tmpdir(), "spay-durable-"));

  healthy = await startWatcher(join(dir, "ledger.json"), "ok");

  // A path whose parent is a FILE, so no write to it can ever succeed. The same
  // class as a full disk or a permission the process does not have, which is
  // what happened in the audit run that found this.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  broken = await startWatcher(join(blocker, "ledger.json"), "broken");
});

after(() => {
  healthy?.server.close();
  broken?.server.close();
  rpc?.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const create = (w, id, n) =>
  fetch(`${w.base}/invoices`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ token: "STRK", amount: "1", receiveAddress: address(n), id }),
  });

test("a create that reaches the disk is reported as created", async () => {
  const res = await create(healthy, "durable-1", 1);
  assert.equal(res.status, 201);
  assert.equal(existsSync(healthy.storePath), true, "the ledger file must exist on disk");

  const status = await (await fetch(`${healthy.base}/status`, { headers: auth })).json();
  assert.equal(status.store, "ok");
  assert.equal(status.storeError, null);
});

test("a create that does NOT reach the disk is refused rather than reported as created", async () => {
  const res = await create(broken, "durable-2", 2);
  assert.equal(res.status, 503, "201 would tell the merchant an invoice exists that does not");
  const body = await res.json();
  assert.match(body.error, /could not be written/);
  assert.match(body.error, /nothing was created/);
  assert.equal(existsSync(broken.storePath), false, "and nothing was written");
});

test("the refused invoice is not left in memory pretending to be real", async () => {
  // Left behind, the next poll would watch an address the merchant has been
  // told does not exist, and a payment to it would confirm against an order
  // that was never filed.
  const list = await (await fetch(`${broken.base}/invoices`, { headers: auth })).json();
  const rows = Array.isArray(list) ? list : list.invoices;
  assert.equal(
    rows.some((r) => r.id === "durable-2"),
    false,
    "the refused id must be gone",
  );
});

test("an unwritable ledger is visible to the operator, and to nobody else", async () => {
  const status = await fetch(`${broken.base}/status`, { headers: auth });
  assert.equal(status.status, 503, "the operator's probe must go red");
  const body = await status.json();
  assert.equal(body.store, "unwritable");
  assert.ok(body.storeError, "and say what went wrong");
  assert.ok(body.storePath, "and where");

  // The public probe says only that the process is answering. Whether the
  // ledger is writable is the operator's business, not a stranger's.
  const pub = await (await fetch(`${broken.base}/public/healthz`)).json();
  assert.deepEqual(pub, { ok: true, watcher: true });

  // And /status needs the token like every other merchant route.
  assert.equal((await fetch(`${broken.base}/status`)).status, 401);
});

test("the healthy watcher is unaffected by the broken one", async () => {
  // Two instances share nothing but this process. If they did share state, the
  // refusal above would have been recorded against the wrong ledger.
  const status = await (await fetch(`${healthy.base}/status`, { headers: auth })).json();
  assert.equal(status.store, "ok");
  assert.equal((await create(healthy, "durable-4", 4)).status, 201);
});
