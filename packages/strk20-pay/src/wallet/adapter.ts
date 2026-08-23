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
   * The pool's flat fee per operation, in whole token units, or null when it
   * cannot be read. Nothing may assume zero.
   *
   * The direction is not symmetric, and getting it wrong cost this project a
   * release: the pool takes the fee OUT of a deposit (send X, get X - fee
   * credited) and charges it ON TOP of a withdrawal or transfer (move A out,
   * spend A + fee). So a payer who already holds shielded funds needs
   * amount + fee, and one who must deposit first needs amount + 2 x fee.
   * `shieldedNeededFor` and `depositNeededFor` are those two answers; do not
   * compute either by hand.
   */
  poolFee?(token: string): Promise<Amount | null>;
  /**
   * Where a human can look this up, or null when there is nowhere to look.
   * The UI must not build explorer links itself: it does not know which chain
   * the adapter is on, and a mock wallet's invented hashes have no explorer at
   * all. Hardcoding mainnet Voyager produced receipts whose links 404'd, on
   * sepolia and in every demo.
   */
  explorerUrl?(kind: "tx" | "address", value: string): string | null;
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
    /**
     * Might this error have followed a transaction reaching the network?
     *
     * Defaults to TRUE, which is the safe answer: an adapter that does not
     * think about it gets "assume the money may be gone", and the checkout
     * refuses to pay again rather than risking a double spend.
     *
     * Only set false where the code path provably precedes submission - a
     * missing connection, an amount that fails validation, a token that is not
     * registered. Never on a catch around the submit call itself.
     *
     * This replaced substring-matching the message. `didNotReachTheChain` used
     * to look for "invalid" / "expired" / "is not connected" anywhere in free
     * text, so a wallet that broadcast and then reported "Invalid response
     * from the node" had its pending marker erased and the payer paid twice.
     * The wallet vendor chose the wording; we chose to trust it.
     */
    readonly submitted: boolean = true,
  ) {
    super(message);
    this.name = "WalletActionError";
  }
}
