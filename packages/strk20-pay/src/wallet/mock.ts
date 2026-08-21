import type { Amount, Network } from "../types.js";
import { WalletActionError, type WalletAdapter } from "./adapter.js";

interface MockOptions {
  network?: Network;
  /** ms per simulated step; keep small in tests, human-scale in demos. */
  latency?: number;
  /** Starting public balance per token. */
  funded?: Record<string, string>;
  /** Force a failure at a given action, for UX-path testing. */
  failAt?: "connect" | "shield" | "privateTransfer" | "unshield";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * In-memory wallet with the exact adapter surface, so the full checkout flow:
 * including the shield-then-pay path and every failure branch: runs with no
 * extension, no network, and no funds. Used by the demo arcade until the
 * Sepolia adapter lands, and by tests forever.
 */
export class MockWallet implements WalletAdapter {
  readonly network: Network;
  private readonly latency: number;
  private readonly failAt?: MockOptions["failAt"];
  private connected = false;
  private pub = new Map<string, bigint>();
  private shielded = new Map<string, bigint>();
  private txCounter = 0;

  constructor(opts: MockOptions = {}) {
    this.network = opts.network ?? "sepolia";
    this.latency = opts.latency ?? 600;
    this.failAt = opts.failAt;
    for (const [token, amount] of Object.entries(opts.funded ?? { STRK: "100" })) {
      this.pub.set(token, toUnits(amount));
    }
  }

  async connect(): Promise<{ address: string }> {
    await wait(this.latency);
    if (this.failAt === "connect") throw new WalletActionError("connect", "User rejected the connection.");
    this.connected = true;
    return { address: "0x0mock" + (1000 + Math.floor(Math.random() * 9000)).toString(16) };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publicBalance(token: string): Promise<Amount> {
    return fromUnits(this.pub.get(token) ?? 0n);
  }

  async shieldedBalance(token: string): Promise<Amount> {
    return fromUnits(this.shielded.get(token) ?? 0n);
  }

  async shield(token: string, amount: Amount): Promise<{ txHash: string }> {
    this.assertConnected("shield");
    await wait(this.latency * 2); // screening + acceptance
    if (this.failAt === "shield") throw new WalletActionError("shield", "Deposit rejected by compliance screening.");
    this.move(this.pub, this.shielded, token, amount, "shield");
    return { txHash: this.hash() };
  }

  async privateTransfer(token: string, amount: Amount, _toPoolAddress: string): Promise<{ txHash: string }> {
    this.assertConnected("privateTransfer");
    await wait(this.latency * 2); // proof generation happens in the wallet
    if (this.failAt === "privateTransfer")
      throw new WalletActionError("privateTransfer", "Wallet failed to prove the transfer.");
    this.take(this.shielded, token, amount, "privateTransfer");
    return { txHash: this.hash() };
  }

  async unshield(token: string, amount: Amount, _toAddress: string): Promise<{ txHash: string }> {
    this.assertConnected("unshield");
    await wait(this.latency * 2);
    if (this.failAt === "unshield") throw new WalletActionError("unshield", "Wallet failed to prove the withdrawal.");
    this.take(this.shielded, token, amount, "unshield");
    return { txHash: this.hash() };
  }

  /** Simulates the ~10-block note maturation delay. */
  async awaitMaturity(onProgress?: (blocksLeft: number) => void): Promise<void> {
    for (let left = 3; left > 0; left--) {
      onProgress?.(left);
      await wait(this.latency / 3);
    }
  }

  private assertConnected(action: "shield" | "privateTransfer" | "unshield"): void {
    if (!this.connected) throw new WalletActionError(action, "Wallet is not connected.");
  }

  private move(from: Map<string, bigint>, to: Map<string, bigint>, token: string, amount: Amount, action: "shield"): void {
    this.take(from, token, amount, action);
    to.set(token, (to.get(token) ?? 0n) + toUnits(amount));
  }

  private take(
    from: Map<string, bigint>,
    token: string,
    amount: Amount,
    action: "shield" | "privateTransfer" | "unshield",
  ): void {
    const bal = from.get(token) ?? 0n;
    const amt = toUnits(amount);
    if (amt <= 0n) throw new WalletActionError(action, "Amount must be positive.");
    if (bal < amt) throw new WalletActionError(action, `Insufficient ${token} balance.`);
    from.set(token, bal - amt);
  }

  private hash(): string {
    return "0x" + (++this.txCounter).toString(16).padStart(4, "0") + "f".repeat(56);
  }
}

const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;

function toUnits(amount: Amount): bigint {
  const [ip = "0", fp = ""] = amount.trim().split(".");
  if (!/^\d*$/.test(ip) || !/^\d*$/.test(fp) || fp.length > Number(DECIMALS)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  return BigInt(ip || "0") * ONE + BigInt((fp + "0".repeat(Number(DECIMALS))).slice(0, Number(DECIMALS)) || "0");
}

function fromUnits(units: bigint): Amount {
  const ip = units / ONE;
  const fp = (units % ONE).toString().padStart(Number(DECIMALS), "0").replace(/0+$/, "");
  return fp ? `${ip}.${fp}` : ip.toString();
}
