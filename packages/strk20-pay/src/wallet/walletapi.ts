// The real wallet adapter: Privacy Wallet API via get-starknet v6 + starknet.js
// WalletAccountV6. All heavy libraries load lazily inside methods, so the
// widget stays importable (and testable) in environments without them wired.
//
// Every private action is exactly one STRK20_ACTION handed to the wallet:
// and a deposit is NEVER bundled with a transfer: the deposit is a public leg
// naming the sender, so bundling would let an observer correlate both ends.
// Unlinkability comes from shielding earlier, separately.
import type { Amount, Network } from "../types.js";
import { WalletActionError, type WalletAdapter } from "./adapter.js";
import { TOKENS, type TokenInfo, amountToFelt, resolveToken, unitsToAmount } from "../tokens.js";

/** Wallet-API version that introduced the STRK20 methods (Ready, Xverse). */
export const MIN_STRK20_WALLET_API = "0.10.3";

/** Pool notes become spendable this many blocks after the deposit lands. */
export const MATURITY_BLOCKS = 10;

export interface WalletApiOptions {
  network: Network;
  /** JSON-RPC endpoint; required on Sepolia, defaults to a public one on mainnet. */
  rpcUrl?: string;
  /** Extra token registry entries (symbol → address + decimals). */
  tokens?: Record<string, TokenInfo>;
  /** Preferred wallet name substring when several STRK20 wallets are present. */
  preferWallet?: string;
  /** How long to keep re-scanning for late-injecting wallet extensions. */
  discoveryTimeoutMs?: number;
}

interface DiscoveredWallet {
  name: string;
  wallet: unknown;
  strk20: boolean;
}

export class WalletApiAdapter implements WalletAdapter {
  readonly network: Network;
  private readonly rpcUrl: string;
  private readonly registry: Record<string, TokenInfo>;
  private readonly preferWallet: string;
  private readonly discoveryTimeoutMs: number;
  private account: { address: string } | null = null;
  private shieldedAtBlock: number | null = null;
  private accountV6: any = null;
  private provider: any = null;

  constructor(opts: WalletApiOptions) {
    this.network = opts.network;
    const fallback = opts.network === "mainnet" ? "https://rpc.starknet.lava.build" : undefined;
    const rpcUrl = opts.rpcUrl ?? fallback;
    if (!rpcUrl) throw new Error("rpcUrl is required on Sepolia.");
    this.rpcUrl = rpcUrl;
    this.registry = { ...TOKENS, ...opts.tokens };
    this.preferWallet = (opts.preferWallet ?? "ready").toLowerCase();
    this.discoveryTimeoutMs = opts.discoveryTimeoutMs ?? 2500;
  }

  isConnected(): boolean {
    return this.account !== null;
  }

  /** Discover wallets and report their STRK20 capability (for custom pickers). */
  async listWallets(): Promise<DiscoveredWallet[]> {
    const [{ createStore }, { walletV6 }, { compareVersions }] = await Promise.all([
      import("@starknet-io/get-starknet-discovery"),
      import("starknet"),
      import("starknet"),
    ]).then(([d, s]) => [d, s, s] as const);

    const store = createStore();
    const found = new Map<string, unknown>();
    const started = Date.now();
    // Legacy injected globals are a one-shot scan; late injections need rescans
    // (the Ready extension can register a beat after page load).
    while (Date.now() - started < this.discoveryTimeoutMs) {
      (store as any)._refreshInjectedWallets?.();
      for (const w of store.getWallets() as any[]) found.set(w.name ?? String(found.size), w);
      if (found.size > 0 && Date.now() - started > 400) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const out: DiscoveredWallet[] = [];
    for (const [name, wallet] of found) {
      let strk20 = false;
      try {
        const versions: string[] = await (walletV6 as any).supportedWalletApi(wallet);
        strk20 = versions.some((v) => compareVersions(v, MIN_STRK20_WALLET_API) >= 0);
      } catch {
        strk20 = false; // wallets predating supportedWalletApi are not capable
      }
      out.push({ name, wallet, strk20 });
    }
    return out;
  }

  async connect(): Promise<{ address: string }> {
    try {
      const { RpcProvider, WalletAccountV6 } = (await import("starknet")) as any;
      this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });

      const wallets = await this.listWallets();
      const capable = wallets.filter((w) => w.strk20);
      if (capable.length === 0) {
        const seen = wallets.map((w) => w.name).join(", ") || "none";
        throw new Error(
          `No wallet here can make private payments (detected: ${seen}). Update your Ready extension to the latest version (it is now called Ready X) and enable Smart Wallet + Private.`,
        );
      }
      const pick =
        capable.find((w) => w.name.toLowerCase().includes(this.preferWallet)) ?? capable[0]!;
      this.accountV6 = await WalletAccountV6.connect(this.provider, pick.wallet);
      this.account = { address: this.accountV6.address };
      return this.account;
    } catch (err) {
      throw new WalletActionError("connect", err instanceof Error ? err.message : "Wallet connection failed.", err);
    }
  }

  async publicBalance(token: string): Promise<Amount> {
    const info = resolveToken(token, this.registry);
    const { RpcProvider } = (await import("starknet")) as any;
    this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
    const result: string[] = await this.provider.callContract({
      contractAddress: info.address,
      entrypoint: "balanceOf",
      calldata: [this.requireAddress()],
    });
    const low = BigInt(result[0] ?? "0x0");
    const high = BigInt(result[1] ?? "0x0");
    return unitsToAmount(low + (high << 128n), info.decimals);
  }

  async shieldedBalance(token: string): Promise<Amount | null> {
    const info = resolveToken(token, this.registry);
    this.requireAddress();
    try {
      // wallet_strk20Balances via WalletAccountV6. The wallet may ask the user
      // for consent: only call this once a payment flow has actually started.
      const entries: Array<{ token: string; balance: string }> =
        await this.accountV6.strk20Balances([info.address]);
      const entry = entries.find((e) => BigInt(e.token) === BigInt(info.address));
      return unitsToAmount(BigInt(entry?.balance ?? "0x0"), info.decimals);
    } catch {
      // The wallet declined to report. Say UNKNOWN: answering zero here would
      // make the caller shield funds the user has already shielded.
      return null;
    }
  }

  async shield(token: string, amount: Amount): Promise<{ txHash: string }> {
    const result = await this.invoke("shield", this.actionsShield(token, amount));
    this.shieldedAtBlock = await this.blockOfTx(result.txHash).catch(() => null);
    return result;
  }

  /**
   * Wait until the notes created by our last shield are spendable. Without this
   * a payment fires one block after the deposit and cannot succeed, because a
   * pool note only matures after MATURITY_BLOCKS.
   */
  async awaitMaturity(onProgress?: (blocksLeft: number) => void): Promise<void> {
    const start = this.shieldedAtBlock;
    if (start === null) return;
    const target = start + MATURITY_BLOCKS;
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const head = await this.currentBlock().catch(() => null);
      if (head !== null) {
        const left = target - head;
        if (left <= 0) return;
        onProgress?.(left);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    // Falling through is deliberate: let the payment attempt produce the real
    // error rather than inventing one from a timer.
  }

  private async blockOfTx(txHash: string): Promise<number | null> {
    const { RpcProvider } = (await import("starknet")) as any;
    this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
    for (let i = 0; i < 30; i++) {
      const receipt = await this.provider.getTransactionReceipt(txHash).catch(() => null);
      const block = receipt?.block_number;
      if (typeof block === "number") return block;
      await new Promise((r) => setTimeout(r, 4_000));
    }
    return null;
  }

  private async currentBlock(): Promise<number> {
    const { RpcProvider } = (await import("starknet")) as any;
    this.provider ??= new RpcProvider({ nodeUrl: this.rpcUrl });
    return this.provider.getBlockNumber();
  }

  async privateTransfer(token: string, amount: Amount, toPoolAddress: string): Promise<{ txHash: string }> {
    return this.invoke("privateTransfer", this.actionsTransfer(token, amount, toPoolAddress));
  }

  async unshield(token: string, amount: Amount, toAddress: string): Promise<{ txHash: string }> {
    return this.invoke("unshield", this.actionsWithdraw(token, amount, toAddress));
  }

  /** Action builders are pure and exported for tests. */
  actionsShield(token: string, amount: Amount) {
    const info = resolveToken(token, this.registry);
    return [{ type: "deposit", token: info.address, amount: amountToFelt(amount, info.decimals) }] as const;
  }

  actionsTransfer(token: string, amount: Amount, recipient: string) {
    const info = resolveToken(token, this.registry);
    return [
      { type: "transfer", token: info.address, amount: amountToFelt(amount, info.decimals), recipient },
    ] as const;
  }

  actionsWithdraw(token: string, amount: Amount, recipient: string) {
    const info = resolveToken(token, this.registry);
    return [
      { type: "withdraw", token: info.address, amount: amountToFelt(amount, info.decimals), recipient },
    ] as const;
  }

  private async invoke(
    action: "shield" | "privateTransfer" | "unshield",
    actions: readonly unknown[],
  ): Promise<{ txHash: string }> {
    this.requireAddress();
    try {
      const { transaction_hash } = await this.accountV6.strk20InvokeTransaction(actions as unknown[]);
      return { txHash: transaction_hash };
    } catch (err) {
      throw new WalletActionError(action, explainWalletError(err, action), err);
    }
  }

  private requireAddress(): string {
    if (!this.account) throw new WalletActionError("connect", "Wallet is not connected.");
    return this.account.address;
  }
}

/**
 * Turn a raw wallet error into something a payer can act on.
 *
 * The one everybody hits first is NOT_REGISTERED: every pool user publishes a
 * viewing key on-chain once, and until that lands the pool will not accept a
 * deposit. Wallets do it as part of their own first shield, so the fix is a
 * one-time action in the wallet rather than anything this app can sign for.
 */
export function explainWalletError(err: unknown, action: "shield" | "privateTransfer" | "unshield"): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/NOT_REGISTERED/i.test(raw)) {
    return (
      "Your wallet is not registered with the privacy pool yet. This is a one-time step: " +
      "open your wallet, shield any amount there once (that publishes your viewing key on-chain), " +
      "wait about ten blocks, then come back and pay."
    );
  }
  if (/SCREENING|COMPLIANCE|BLOCKED/i.test(raw)) {
    return "The privacy pool's compliance screening rejected this deposit. Deposits are screened on every route.";
  }
  if (/INSUFFICIENT|BALANCE/i.test(raw)) {
    return `Not enough balance to ${action === "shield" ? "shield" : "pay"}, including fees.`;
  }
  if (/reject|denied|USER_REFUSED|cancel/i.test(raw)) {
    return "You dismissed the wallet prompt.";
  }
  return raw || `${action} failed in the wallet.`;
}
