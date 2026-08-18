import type { Amount, Network } from "../types";

/**
 * The only surface the checkout core is allowed to touch.
 *
 * Deliberately mirrors the four actions the Privacy Wallet API ships today
 * (shield / private transfer / unshield / swap) — nothing in the core may
 * assume capabilities beyond these, so the mainnet path stays unblocked.
 */
export interface WalletAdapter {
  readonly network: Network;
  connect(): Promise<{ address: string }>;
  isConnected(): boolean;
  /** Public ERC-20 balance (pre-shield). */
  publicBalance(token: string): Promise<Amount>;
  /** Shielded (in-pool) balance. */
  shieldedBalance(token: string): Promise<Amount>;
  /** Deposit into the pool. PUBLIC + compliance-screened. Resolves at acceptance. */
  shield(token: string, amount: Amount): Promise<{ txHash: string }>;
  /** Private note-to-note transfer to a registered pool user. */
  privateTransfer(token: string, amount: Amount, toPoolAddress: string): Promise<{ txHash: string }>;
  /** Exit the pool to a public address. Destination + amount visible. */
  unshield(token: string, amount: Amount, toAddress: string): Promise<{ txHash: string }>;
}

export class WalletActionError extends Error {
  constructor(
    readonly action: "connect" | "shield" | "privateTransfer" | "unshield",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WalletActionError";
  }
}
