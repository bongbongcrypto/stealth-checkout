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
//   POST /invoices  {id?, token|tokenAddress+decimals, amount, receiveAddress, webhookUrl?, expiresAt?}
//   GET  /invoices/:id
//   GET  /healthz

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  TOKENS,
  balanceOfRequest,
  evaluateInvoice,
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
const STORE_PATH = process.env.WATCHER_STORE ?? new URL("./invoices.json", import.meta.url).pathname;

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
  const url = inv.webhookUrl || WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify({
    event: "payment.confirmed",
    invoice: {
      id: inv.id,
      token: inv.token,
      amount: inv.amount,
      receiveAddress: inv.receiveAddress,
      txHash: inv.txHash,
      confirmedAt: inv.confirmedAt,
    },
  });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WEBHOOK_SECRET ? { "X-Spay-Signature": signPayload(WEBHOOK_SECRET, body) } : {}),
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
  }
}

function resolveToken(body) {
  if (body.tokenAddress) {
    if (typeof body.decimals !== "number") throw new Error("decimals required with tokenAddress");
    return { token: body.token ?? "CUSTOM", tokenAddress: body.tokenAddress, decimals: body.decimals };
  }
  const known = TOKENS[body.token];
  if (!known) throw new Error(`Unknown token ${body.token}; pass tokenAddress + decimals`);
  return { token: body.token, tokenAddress: known.address, decimals: known.decimals };
}

function createInvoice(body) {
  if (!body.receiveAddress || !/^0x[0-9a-fA-F]+$/.test(body.receiveAddress)) {
    throw new Error("receiveAddress (hex) is required: one fresh address per invoice");
  }
  const { token, tokenAddress, decimals } = resolveToken(body);
  toUnits(body.amount, decimals); // validate amount format early
  const inv = {
    id: body.id ?? `inv_${randomUUID().slice(0, 8)}`,
    token,
    tokenAddress,
    decimals,
    amount: String(body.amount),
    receiveAddress: body.receiveAddress,
    webhookUrl: body.webhookUrl,
    expiresAt: body.expiresAt,
    status: "watching",
    createdAt: Date.now(),
  };
  if (invoices.has(inv.id)) throw new Error(`Invoice ${inv.id} already exists`);
  invoices.set(inv.id, inv);
  return inv;
}

async function persist() {
  try {
    await writeFile(STORE_PATH, JSON.stringify([...invoices.values()], null, 2));
  } catch {
    /* persistence is best-effort; the chain is the source of truth */
  }
}

async function restore() {
  try {
    const rows = JSON.parse(await readFile(STORE_PATH, "utf8"));
    for (const row of rows) invoices.set(row.id, row);
    log(`restored ${rows.length} invoice(s)`);
  } catch {
    /* first run */
  }
}

function log(msg) {
  console.log(`[watcher ${new Date().toISOString()}] ${msg}`);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(body);
}

export function makeServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, watching: [...invoices.values()].filter((i) => i.status === "watching").length });
      }
      if (req.method === "GET" && url.pathname === "/invoices") {
        return json(res, 200, [...invoices.values()].sort((a, b) => b.createdAt - a.createdAt));
      }
      if (req.method === "POST" && url.pathname === "/invoices") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const inv = createInvoice(JSON.parse(raw || "{}"));
        await persist();
        log(`watching ${inv.id} → ${inv.receiveAddress} for ${inv.amount} ${inv.token}`);
        return json(res, 201, inv);
      }
      const match = url.pathname.match(/^\/invoices\/([\w-]+)$/);
      if (req.method === "GET" && match) {
        const inv = invoices.get(match[1]);
        return inv ? json(res, 200, inv) : json(res, 404, { error: "not found" });
      }
      return json(res, 404, { error: "unknown route" });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });
}

export { createInvoice, pollOnce, invoices };

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (isMain) {
  await restore();
  makeServer().listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT}, rpc=${RPC_URL}, poll=${POLL_MS}ms`));
  setInterval(pollOnce, POLL_MS);
  void pollOnce();
}
