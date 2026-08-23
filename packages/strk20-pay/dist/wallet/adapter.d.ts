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
    connect(): Promise<{
        address: string;
    }>;
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
     * cannot be read. Charged ON TOP of the amount and once per operation, so a
     * payer who has to shield first pays it twice. Nothing may assume zero.
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
    shield(token: string, amount: Amount): Promise<{
        txHash: string;
    }>;
    /** Private note-to-note transfer to a registered pool user. */
    privateTransfer(token: string, amount: Amount, toPoolAddress: string): Promise<{
        txHash: string;
    }>;
    /** Exit the pool to a public address. Destination + amount visible. */
    unshield(token: string, amount: Amount, toAddress: string): Promise<{
        txHash: string;
    }>;
}
export declare class WalletActionError extends Error {
    readonly action: "connect" | "shield" | "privateTransfer" | "unshield";
    readonly cause?: unknown | undefined;
    constructor(action: "connect" | "shield" | "privateTransfer" | "unshield", message: string, cause?: unknown | undefined);
}
