#!/usr/bin/env node
// Invoice watcher: watches per-invoice receive addresses over public RPC and
// fires signed webhooks when a payment lands. This is the piece that makes
// accepting private payments headless: no proving, no discovery service,
// nothing beyond a JSON-RPC endpoint.
//
//   WATCHER_RPC=https://rpc.starknet.lava.build \
//   WEBHOOK_SECRET=whsec_xxx node server/watcher/watcher.mjs
//
// API (merchant-facing, bind localhost or put behind your own auth):
//   POST   /invoices      {id?, token | tokenAddress+decimals, amount, receiveAddress, expiresAt?}
//   GET    /invoices      every invoice, newest first
//   GET    /invoices/:id  one invoice
//   DELETE /invoices/:id  release a reserving / expired / needs_reregistration row
//   GET    /healthz       unauthenticated liveness

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  TOKENS,
  UNPAYABLE_STATES,
  balanceOfRequest,
  evaluateInvoice,
  hasUsableBaseline,
  sameAddress,
  signPayload,
  toUnits,
  transferEventsRequest,
  txHashFromEvents,
  u256FromCallResult,
} from "./lib.mjs";

const RPC_URL = process.env.WATCHER_RPC ?? "https://rpc.starknet.lava.build";
const PORT = Number(process.env.WATCHER_PORT ?? 8787);
const POLL_MS = Number(process.env.WATCHER_POLL_MS ?? 15_000);
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
/** Required. Every request must carry `Authorization: Bearer <token>`. */
const API_TOKEN = process.env.WATCHER_TOKEN ?? "";
/** Exact origin allowed to call this from a browser. No wildcard. */
const ALLOWED_ORIGIN = process.env.WATCHER_ORIGIN ?? "";
const STORE_PATH = process.env.WATCHER_STORE ?? fileURLToPath(new URL("./invoices.json", import.meta.url));

/** @type {Map<string, any>} */
const invoices = new Map();
let rpcId = 0;

async function rpc(body) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  return json.result;
}

async function currentBlock() {
  return rpc({ jsonrpc: "2.0", id: ++rpcId, method: "starknet_blockNumber", params: [] });
}

let polling = false;

/** Guarded so two cycles never confirm the same invoice and double-fire. */
export async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    await pollOnce();
  } finally {
    polling = false;
  }
}

async function pollOnce() {
  for (const [id, inv] of invoices) {
    if (inv.status !== "watching") continue;
    try {
      const result = await rpc(balanceOfRequest(inv.tokenAddress, inv.receiveAddress, ++rpcId));
      const balance = u256FromCallResult(result);
      const next = evaluateInvoice(inv, balance);
      if (next !== inv) {
        invoices.set(id, next);
        await persist();
        if (next.status === "paid") {
          next.txHash = await findTxHash(next).catch(() => undefined);
          await persist();
          await deliverWebhook(next);
        }
        log(`${id} → ${next.status}${next.txHash ? ` (${next.txHash.slice(0, 12)}…)` : ""}`);
      }
    } catch (err) {
      // RPC refusal is not a chain answer: keep watching, never mark unpaid.
      log(`${id} poll error: ${err.message}`);
    }
  }
}

async function findTxHash(inv) {
  const head = await currentBlock();
  const from = Math.max(0, head - 2000);
  const events = await rpc(transferEventsRequest(inv.tokenAddress, inv.receiveAddress, from, ++rpcId));
  return txHashFromEvents(events, inv.receiveAddress);
}

async function deliverWebhook(inv, attempt = 1) {
  // Server configuration only. An invoice can never name its own endpoint.
  if (!WEBHOOK_URL) return;
  if (!WEBHOOK_SECRET) {
    // Sending unsigned would let anyone who can reach the merchant's endpoint
    // forge a confirmation. Refuse instead of downgrading silently.
    log(`webhook ${inv.id} NOT SENT: WEBHOOK_SECRET is unset, refusing to send unsigned`);
    return;
  }
  const deliveryId = inv.deliveryId ?? `dlv_${randomUUID()}`;
  if (!inv.deliveryId) {
    inv.deliveryId = deliveryId;
    invoices.set(inv.id, inv);
  }
  const body = JSON.stringify({
    event: "payment.confirmed",
    deliveryId, // stable across retries: merchants dedupe on this
    invoice: {
      id: inv.id,
      token: inv.token,
      amount: inv.amount,
      receiveAddress: inv.receiveAddress,
      txHash: inv.txHash ?? null,
      receivedUnits: inv.receivedUnits ?? null,
      confirmedAt: inv.confirmedAt,
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Spay-Timestamp": String(timestamp),
        "X-Spay-Signature": signPayload(WEBHOOK_SECRET, body, timestamp),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    invoices.set(inv.id, { ...invoices.get(inv.id), webhookDeliveredAt: Date.now() });
    await persist();
  } catch (err) {
    log(`webhook ${inv.id} attempt ${attempt} failed: ${err.message}`);
    if (attempt < 5) setTimeout(() => deliverWebhook(inv, attempt + 1), attempt * 30_000);
    else log(`webhook ${inv.id} GAVE UP after ${attempt} attempts; query GET /invoices/${inv.id} to reconcile`);
  }
}

function knownToken(symbol) {
  // Own properties only: "toString" and "__proto__" otherwise resolve to junk.
  return Object.prototype.hasOwnProperty.call(TOKENS, symbol) ? TOKENS[symbol] : undefined;
}

function resolveToken(body) {
  if (body.tokenAddress !== undefined) {
    if (typeof body.tokenAddress !== "string" || !/^0x[0-9a-fA-F]{10,64}$/.test(body.tokenAddress)) {
      throw new Error("tokenAddress must be a hex Starknet address");
    }
    if (!Number.isInteger(body.decimals) || body.decimals < 0 || body.decimals > 36) {
      throw new Error("decimals must be an integer between 0 and 36");
    }
    // Declaring the wrong decimals for a token we know would confirm an
    // invoice for "1 STRK" on a millionth of one while the webhook still
    // reports "1 STRK". Look the token up BY ADDRESS: keying on the label let
    // "strk", " STRK", or simply omitting the label walk straight past this.
    for (const [symbol, known] of Object.entries(TOKENS)) {
      if (sameAddress(known.address, body.tokenAddress) && known.decimals !== body.decimals) {
        throw new Error(`${symbol} has ${known.decimals} decimals, not ${body.decimals}`);
      }
    }
    return { token: body.token ?? "CUSTOM", tokenAddress: body.tokenAddress, decimals: body.decimals };
  }
  const known = knownToken(body.token);
  if (!known) throw new Error(`Unknown token ${body.token}; pass tokenAddress + decimals`);
  return { token: body.token, tokenAddress: known.address, decimals: known.decimals };
}

/**
 * Register an invoice. The baseline balance is read HERE, once, so payment is
 * always judged as a delta. Callers cannot choose the webhook URL: letting
 * them would turn this into an oracle that signs arbitrary bodies with the
 * merchant's secret.
 */
async function createInvoice(body) {
  // Type checks, not coercion: `.test()` stringifies, so ["0x0abc…"] used to
  // pass as an address and then silently never match on-chain.
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  if (typeof body.receiveAddress !== "string" || !/^0x[0-9a-fA-F]{10,64}$/.test(body.receiveAddress)) {
    throw new Error("receiveAddress must be a hex string (0x plus 10-64 digits): one fresh address per invoice");
  }
  if (body.token !== undefined && typeof body.token !== "string") throw new Error("token must be a string");
  if (body.id !== undefined && typeof body.id !== "string") throw new Error("id must be a string");
  if (body.expiresAt !== undefined && typeof body.expiresAt !== "number") {
    throw new Error("expiresAt must be a number of milliseconds since the epoch");
  }
  const { token, tokenAddress, decimals } = resolveToken(body);
  const amount = String(body.amount ?? "").trim();
  const target = toUnits(amount, decimals); // validates format
  if (target <= 0n) throw new Error("amount must be greater than zero");
  if (body.expiresAt !== undefined && (!Number.isFinite(body.expiresAt) || body.expiresAt <= 0)) {
    throw new Error("expiresAt must be a positive millisecond timestamp");
  }

  const id = body.id ?? `inv_${randomUUID().slice(0, 8)}`;
  if (!/^[\w.-]{1,64}$/.test(id)) throw new Error("id must be 1-64 chars of [A-Za-z0-9_.-]");
  if (invoices.has(id)) throw new Error(`Invoice ${id} already exists`);

  // Any invoice that ever used this address, not just a live one: a late
  // payment against an expired invoice would otherwise settle its successor.
  for (const other of invoices.values()) {
    if (sameAddress(other.receiveAddress, body.receiveAddress)) {
      throw new Error(`receiveAddress was already used by invoice ${other.id}; use a fresh address`);
    }
  }

  // Reserve before awaiting: two concurrent POSTs would otherwise both pass
  // the checks above, and the second would overwrite the first, leaving the
  // first order's address unwatched.
  invoices.set(id, { id, status: "reserving", receiveAddress: body.receiveAddress, createdAt: Date.now() });
  let baseline;
  try {
    baseline = u256FromCallResult(await rpc(balanceOfRequest(tokenAddress, body.receiveAddress, ++rpcId)));
  } catch (err) {
    invoices.delete(id); // never leave a half-created row behind
    throw err;
  }
  const inv = {
    id,
    token,
    tokenAddress,
    decimals,
    amount,
    receiveAddress: body.receiveAddress,
    baselineUnits: baseline.toString(),
    expiresAt: body.expiresAt === undefined ? undefined : Number(body.expiresAt),
    status: "watching",
    createdAt: Date.now(),
  };
  invoices.set(inv.id, inv);
  return inv;
}

async function persist() {
  try {
    await writeFile(STORE_PATH, JSON.stringify([...invoices.values()], null, 2));
  } catch (err) {
    // Loud, because the invoice-to-order mapping lives ONLY here. Losing it
    // means a paid invoice can never be matched back to an order.
    log(`PERSISTENCE FAILED (${STORE_PATH}): ${err.message}`);
  }
}

async function restore() {
  let raw;
  try {
    raw = await readFile(STORE_PATH, "utf8");
  } catch {
    return; // first run
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("expected an array of invoices");
    const rows = [];
    let dropped = 0;
    for (const row of parsed) {
      // One malformed row must not stop the process from booting: that turns a
      // hand-edit into a total outage with no repair tool.
      if (row && typeof row === "object" && typeof row.id === "string") rows.push(row);
      else dropped++;
    }
    let quarantined = 0;
    for (const row of rows) {
      // Rows from a build that predates baselines cannot be judged safely.
      // Park them rather than watching them: watching would confirm on the
      // absolute balance and pay out orders nobody paid for.
      if (row.status === "watching" && !hasUsableBaseline(row)) {
        invoices.set(row.id, { ...row, status: "needs_reregistration" });
        quarantined++;
        continue;
      }
      invoices.set(row.id, row);
    }
    log(`restored ${rows.length} invoice(s)`);
    if (dropped > 0) log(`${dropped} unreadable row(s) in the store were skipped`);
    if (quarantined > 0) {
      log(`${quarantined} invoice(s) have no baseline and were NOT resumed: DELETE then re-create them`);
      await persist(); // write the quarantine back, or the file keeps saying "watching"
    }
  } catch (err) {
    // Never silently start empty on a corrupt store: that looks identical to
    // a first run and quietly drops every open invoice.
    throw new Error(`invoice store at ${STORE_PATH} is corrupt: ${err.message}`);
  }
}

function log(msg) {
  console.log(`[watcher ${new Date().toISOString()}] ${msg}`);
}

/**
 * No wildcard. A wildcard plus a bearer token still lets any page the merchant
 * visits read the whole invoice ledger once that token leaks into a script.
 * Set WATCHER_ORIGIN to the exact dashboard origin, or leave it unset to
 * refuse browsers entirely.
 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGIN || origin !== ALLOWED_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

/** Constant-time bearer check. */
function authorized(req) {
  const header = req.headers.authorization ?? "";
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${API_TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function json(req, res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { "Content-Type": "application/json", ...corsHeaders(req) });
  res.end(body);
}

/** Read a bounded body: an unbounded one is a free memory-exhaustion attack. */
async function readBody(req, limit = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("request body too large");
  }
  return raw;
}

export function makeServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    // Health is the only unauthenticated route, and it reveals nothing.
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(req, res, 200, { ok: true });
    }
    if (!API_TOKEN) {
      return json(req, res, 503, { error: "WATCHER_TOKEN is not set; the API is disabled" });
    }
    if (!authorized(req)) {
      return json(req, res, 401, { error: "missing or invalid bearer token" });
    }
    try {
      if (req.method === "GET" && url.pathname === "/invoices") {
        return json(req, res, 200, [...invoices.values()].sort((a, b) => b.createdAt - a.createdAt));
      }
      if (req.method === "POST" && url.pathname === "/invoices") {
        const inv = await createInvoice(JSON.parse((await readBody(req)) || "{}"));
        await persist();
        log(`watching ${inv.id} -> ${inv.receiveAddress} for ${inv.amount} ${inv.token} (baseline ${inv.baselineUnits})`);
        return json(req, res, 201, inv);
      }
      const match = url.pathname.match(/^\/invoices\/([\w.-]+)$/);
      if (req.method === "GET" && match) {
        const inv = invoices.get(match[1]);
        return inv ? json(req, res, 200, inv) : json(req, res, 404, { error: "not found" });
      }
      // Recovery. A crash mid-create, or a row from an older build, otherwise
      // locks its id AND its address forever with no way back but hand-editing
      // the store. Settled invoices stay: deleting one would let its address be
      // reused and a late payment settle the successor.
      if (req.method === "DELETE" && match) {
        const inv = invoices.get(match[1]);
        if (!inv) return json(req, res, 404, { error: "not found" });
        if (!UNPAYABLE_STATES.has(inv.status)) {
          return json(req, res, 409, {
            error: `invoice ${inv.id} is ${inv.status}; only reserving, expired or needs_reregistration rows can be deleted`,
          });
        }
        invoices.delete(inv.id);
        await persist();
        log(`deleted ${inv.id} (was ${inv.status})`);
        return json(req, res, 200, { deleted: inv.id, was: inv.status });
      }
      return json(req, res, 404, { error: "unknown route" });
    } catch (err) {
      return json(req, res, 400, { error: err.message });
    }
  });
}

export { createInvoice, pollOnce, invoices, deliverWebhook };

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (isMain) {
  await restore();
  makeServer().listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT}, rpc=${RPC_URL}, poll=${POLL_MS}ms`));
  setInterval(pollLoop, POLL_MS);
  void pollLoop();
}
