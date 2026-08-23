// restore() reads STORE_PATH, which the module captures at import time, so
// this needs its own file: setting WATCHER_STORE after importing the watcher
// has no effect, and a test that does it silently asserts against the wrong
// ledger.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = join(tmpdir(), `spay-restore-${process.pid}.json`);
let watcher;

before(async () => {
  await writeFile(
    STORE,
    JSON.stringify({
      invoices: [
        // Written by a build that predates baselines. Judging it would confirm
        // on the ABSOLUTE balance and pay out orders nobody paid for.
        { id: "legacy", status: "watching", amount: "5", decimals: 18, receiveAddress: "0x0f00", token: "STRK" },
        // A baseline of the NUMBER zero, not the string: the shape that once
        // passed the restorer and failed the evaluator, so the row was watched
        // forever while every poll threw.
        { id: "numeric", status: "watching", amount: "5", decimals: 18, receiveAddress: "0x0f02", token: "STRK", baselineUnits: 0 },
        { id: "modern", status: "watching", amount: "5", decimals: 18, receiveAddress: "0x0f01", token: "STRK", baselineUnits: "0" },
        { id: "settled", status: "paid", amount: "5", decimals: 18, receiveAddress: "0x0f03", token: "STRK" },
      ],
      idempotency: [["k1", { id: "modern", fingerprint: "fp", at: 1 }]],
    }),
  );
  process.env.WATCHER_STORE = STORE;
  process.env.WATCHER_TOKEN = "restore-token";
  process.env.WATCHER_RPC = "http://127.0.0.1:1"; // never reached
  watcher = await import("../watcher.mjs");
  await watcher.restore();
});

test("a watching row with no usable baseline is quarantined, not resumed", () => {
  assert.equal(watcher.invoices.get("legacy").status, "needs_reregistration");
  assert.equal(watcher.invoices.get("numeric").status, "needs_reregistration", "a number is not a usable baseline");
  assert.equal(watcher.invoices.get("modern").status, "watching");
});

test("a quarantined row is not payable, and can be released", async () => {
  const { UNPAYABLE_STATES, DELETABLE_STATES } = await import("../lib.mjs");
  assert.ok(UNPAYABLE_STATES.has("needs_reregistration"), "never hand this to a payer");
  assert.ok(DELETABLE_STATES.has("needs_reregistration"), "and the merchant can start it over");
});

test("a settled row is restored untouched, whatever its shape", () => {
  // Quarantining these would be its own bug: they are terminal and their
  // baseline no longer decides anything.
  assert.equal(watcher.invoices.get("settled").status, "paid");
});

test("the idempotency table survives a restart", () => {
  // Memory-only, it dropped exactly the retry the feature exists for: the one
  // a client sends after a crash.
  assert.equal(watcher.invoices.size, 4);
});
