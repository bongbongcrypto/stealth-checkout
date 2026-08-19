#!/usr/bin/env node
// Live proof, no funds needed: the watcher confirms a "payment" headlessly over
// public mainnet RPC and fires a signed webhook. We watch an address that
// already holds STRK (the STRK20 pool itself) as if it were an invoice address.
//
//   node server/watcher/e2e-live.mjs
//
// Expected output: status paid + webhook with a valid HMAC signature.

import { createServer } from "node:http";
import { verifySignature } from "./lib.mjs";

process.env.WEBHOOK_SECRET = "whsec_e2e";
process.env.WEBHOOK_URL = "http://127.0.0.1:8788/hook";
process.env.WATCHER_RPC = process.env.WATCHER_RPC ?? "https://rpc.starknet.lava.build";

const { createInvoice, pollOnce, invoices } = await import("./watcher.mjs");

const received = new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.end("ok");
    server.close();
    resolve({
      signatureValid: verifySignature("whsec_e2e", raw, req.headers["x-spay-signature"]),
      payload: JSON.parse(raw),
    });
  });
  server.listen(8788, "127.0.0.1");
});

createInvoice({
  id: "e2e_pool",
  token: "STRK",
  amount: "1",
  // The STRK20 pool holds STRK on mainnet — perfect stand-in for a paid invoice.
  receiveAddress: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
});

console.log("polling mainnet…");
await pollOnce();

const inv = invoices.get("e2e_pool");
console.log(`invoice status: ${inv.status}`);
console.log(`tx hash lookup: ${inv.txHash ?? "(best-effort miss — balance is the source of truth)"}`);

const hook = await Promise.race([received, new Promise((r) => setTimeout(() => r({ timeout: true }), 15_000))]);
if (hook.timeout) {
  console.error("webhook: TIMEOUT");
  process.exit(1);
}
console.log(`webhook received: event=${hook.payload.event} signatureValid=${hook.signatureValid}`);
process.exit(inv.status === "paid" && hook.signatureValid ? 0 : 1);
