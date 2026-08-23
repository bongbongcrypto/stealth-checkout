#!/usr/bin/env node
// Live check against Starknet mainnet, spending nothing.
//
//   node server/watcher/e2e-live.mjs
//
// What this proves, and what it does not:
//
//   PROVES  the watcher reads a real mainnet balance over public RPC, measures
//           payment as a delta from the baseline it captured at registration,
//           and refuses to confirm an address that merely holds funds.
//   PROVES  the signed webhook path end to end, including timestamp binding.
//   DOES NOT prove a real payment was detected: that needs someone to actually
//           pay, which this script deliberately will not do with your money.
//
// An earlier version of this file watched the STRK20 pool's own address, which
// holds a lot of STRK, and reported "paid" as evidence that confirmation
// worked. That was a false positive dressed up as a proof. The absolute-balance
// bug it was hiding is fixed, and this script now asserts the opposite.

import { createServer } from "node:http";
import { verifySignature } from "./lib.mjs";

process.env.WATCHER_TOKEN ??= "e2e-token";
process.env.WEBHOOK_SECRET = "whsec_e2e";
process.env.WEBHOOK_URL = "http://127.0.0.1:8788/hook";
process.env.WATCHER_RPC ??= "https://rpc.starknet.lava.build";

const { createInvoice, pollOnce, invoices } = await import("./watcher.mjs");

// The STRK20 pool holds a large STRK balance. A correct watcher must NOT call
// that a payment, because none of it arrived after we started watching.
const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

console.log("reading mainnet…");
const inv = await createInvoice({ id: "e2e_funded", token: "STRK", amount: "1", receiveAddress: POOL });
console.log(`baseline captured: ${inv.baselineUnits} units (the address is already funded)`);

await pollOnce();
const after = invoices.get("e2e_funded");

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

check("a funded address is NOT confirmed as paid", after.status === "watching");
check("a baseline was recorded at registration", BigInt(after.baselineUnits) > 0n);

// Now prove the webhook path, by handing the deliverer an invoice already
// marked paid rather than by faking a chain state.
const received = new Promise((resolve) => {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.end("ok");
    server.close();
    resolve({
      signature: req.headers["x-spay-signature"],
      timestamp: req.headers["x-spay-timestamp"],
      raw,
    });
  });
  server.listen(8788, "127.0.0.1");
});

const paid = { ...after, status: "paid", confirmedAt: Date.now(), receivedUnits: "1" };
invoices.set(paid.id, paid);
const { deliverWebhook } = await import("./watcher.mjs");
await deliverWebhook(paid);

const hook = await Promise.race([received, new Promise((r) => setTimeout(() => r(null), 15_000))]);
if (!hook) {
  check("webhook delivered", false);
} else {
  const body = JSON.parse(hook.raw);
  check("webhook delivered", body.event === "payment.confirmed");
  check("delivery carries an id merchants can dedupe on", typeof body.deliveryId === "string");
  check("signature verifies with the timestamp", verifySignature("whsec_e2e", hook.raw, hook.signature, hook.timestamp));
  const stale = Number(hook.timestamp) - 3600;
  check("the same signature is rejected an hour later", !verifySignature("whsec_e2e", hook.raw, hook.signature, stale));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
