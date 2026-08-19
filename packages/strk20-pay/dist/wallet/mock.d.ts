import type { Amount, Network } from "../types.js";
import { type WalletAdapter } from "./adapter.js";
interface MockOptions {
    network?: Network;
    /** ms per simulated step; keep small in tests, human-scale in demos. */
    latency?: number;
    /** Starting public balance per token. */
    funded?: Record<string, string>;
    /** Force a failure at a given action, for UX-path testing. */
    failAt?: "connect" | "shield" | "privateTransfer" | "unshield";
}
/**
 * In-memory wallet with the exact adapter surface, so the full checkout flow:
 * including the shield-then-pay path and every failure branch: runs with no
 * extension, no network, and no funds. Used by the demo arcade until the
 * Sepolia adapter lands, and by tests forever.
 */
export declare class MockWallet implements WalletAdapter {
    readonly network: Network;
    private readonly latency;
    private readonly failAt?;
    private connected;
    private pub;
    private shielded;
    private txCounter;
    constructor(opts?: MockOptions);
    connect(): Promise<{
        address: string;
    }>;
    isConnected(): boolean;
    publicBalance(token: string): Promise<Amount>;
    shieldedBalance(token: string): Promise<Amount>;
    shield(token: string, amount: Amount): Promise<{
        txHash: string;
    }>;
    privateTransfer(token: string, amount: Amount, _toPoolAddress: string): Promise<{
        txHash: string;
    }>;
    unshield(token: string, amount: Amount, _toAddress: string): Promise<{
        txHash: string;
    }>;
    /** Test/demo hook: simulate the ~10-block note maturation delay. */
    matureNotes(): Promise<void>;
    private assertConnected;
    private move;
    private take;
    private hash;
}
export {};
