import { test } from "node:test";
import assert from "node:assert/strict";
import { WalletApiAdapter, amountToFelt, amountToUnits, explainWalletError, resolveToken, unitsToAmount } from "../dist/index.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

test("token math: units and felts", () => {
  assert.equal(amountToUnits("1", 18), 10n ** 18n);
  assert.equal(amountToFelt("1", 18), "0xde0b6b3a7640000");
  assert.equal(amountToFelt("2.5", 6), "0x2625a0");
  assert.equal(unitsToAmount(15n * 10n ** 17n, 18), "1.5");
  assert.throws(() => amountToUnits("1.2345678", 6), /Invalid amount/);
});

test("token registry: symbols resolve, raw addresses pass through, junk throws", () => {
  assert.equal(resolveToken("STRK").address, STRK);
  assert.equal(resolveToken("0x0abc").address, "0x0abc");
  assert.throws(() => resolveToken("DOGE"), /Unknown token/);
});

test("action builders produce exact Wallet API shapes", () => {
  const adapter = new WalletApiAdapter({ network: "mainnet" });
  assert.deepEqual(adapter.actionsShield("STRK", "1"), [
    { type: "deposit", token: STRK, amount: "0xde0b6b3a7640000" },
  ]);
  assert.deepEqual(adapter.actionsTransfer("STRK", "1", "0x0merchant"), [
    { type: "transfer", token: STRK, amount: "0xde0b6b3a7640000", recipient: "0x0merchant" },
  ]);
  assert.deepEqual(adapter.actionsWithdraw("STRK", "1", "0x0invoice"), [
    { type: "withdraw", token: STRK, amount: "0xde0b6b3a7640000", recipient: "0x0invoice" },
  ]);
});

test("a deposit is never bundled with a transfer (one action per call)", () => {
  const adapter = new WalletApiAdapter({ network: "mainnet" });
  assert.equal(adapter.actionsShield("STRK", "1").length, 1);
  assert.equal(adapter.actionsTransfer("STRK", "1", "0x0m").length, 1);
  assert.equal(adapter.actionsWithdraw("STRK", "1", "0x0i").length, 1);
});

test("sepolia requires an explicit rpcUrl; mainnet has a default", () => {
  assert.throws(() => new WalletApiAdapter({ network: "sepolia" }), /rpcUrl is required/);
  assert.ok(new WalletApiAdapter({ network: "sepolia", rpcUrl: "https://example/rpc" }));
  assert.ok(new WalletApiAdapter({ network: "mainnet" }));
});

test("actions before connect fail with a connect error, not a crash", async () => {
  const adapter = new WalletApiAdapter({ network: "mainnet" });
  await assert.rejects(() => adapter.shield("STRK", "1"), /not connected/);
  await assert.rejects(() => adapter.unshield("STRK", "1", "0x0i"), /not connected/);
});

test("wallet errors are translated into actions the payer can take", () => {
  const reg = explainWalletError(new Error("execution failed: NOT_REGISTERED"), "shield");
  assert.match(reg, /not registered/i);
  assert.match(reg, /one-time/i);
  assert.match(reg, /shield any amount there once/i);

  assert.match(explainWalletError(new Error("USER_REFUSED_OP"), "unshield"), /dismissed/i);
  assert.match(explainWalletError(new Error("insufficient balance"), "shield"), /Not enough balance/i);
  assert.match(explainWalletError(new Error("screening failed"), "shield"), /compliance screening/i);
  // unknown errors pass through rather than being swallowed
  assert.equal(explainWalletError(new Error("weird rpc thing"), "shield"), "weird rpc thing");
});
