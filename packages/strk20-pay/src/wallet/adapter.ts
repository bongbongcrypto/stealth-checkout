import type { Amount, Network } from "../types.js";

/**
 * The only surface the checkout core is allowed to touch.
 *
 * Deliberately mirrors the four actions the Privacy Wallet API ships today
 * (shield / private transfer / unshield / swap): nothing in the core may
 * assume capabilities beyond these, so the mainnet path stays unblocked.
 */
export interface WalletAdapter {
  readonly network: Network;
  connect(): Promise<{ address: string }>;
  isConnected(): boolean;
  /** Public ERC-20 balance (pre-shield). */
  publicBalance(token: string): Promise<Amount>;
  /**
   * Shielded (in-pool) balance, or null when the wallet will not report it.
   * Null means UNKNOWN, never zero: treating a refusal as zero makes a caller
   * shield funds it already has.
   */
  shieldedBalance(token: string): Promise<Amount | null>;
  /**
   * Block until funds shielded by this adapter are spendable. Pool notes mature
   * after roughly ten blocks, so a payment attempted straight after a shield
   * cannot succeed. `onProgress` reports blocks remaining for the UI.
   */
  awaitMaturity?(onProgress?: (blocksLeft: number) => void): Promise<void>;
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
