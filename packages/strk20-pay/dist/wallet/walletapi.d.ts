import type { Amount, Network } from "../types.js";
import { type WalletAdapter } from "./adapter.js";
import { type TokenInfo } from "../tokens.js";
/** Wallet-API version that introduced the STRK20 methods (Ready, Xverse). */
export declare const MIN_STRK20_WALLET_API = "0.10.3";
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
export declare class WalletApiAdapter implements WalletAdapter {
    readonly network: Network;
    private readonly rpcUrl;
    private readonly registry;
    private readonly preferWallet;
    private readonly discoveryTimeoutMs;
    private account;
    private accountV6;
    private provider;
    constructor(opts: WalletApiOptions);
    isConnected(): boolean;
    /** Discover wallets and report their STRK20 capability (for custom pickers). */
    listWallets(): Promise<DiscoveredWallet[]>;
    connect(): Promise<{
        address: string;
    }>;
    publicBalance(token: string): Promise<Amount>;
    shieldedBalance(token: string): Promise<Amount>;
    shield(token: string, amount: Amount): Promise<{
        txHash: string;
    }>;
    privateTransfer(token: string, amount: Amount, toPoolAddress: string): Promise<{
        txHash: string;
    }>;
    unshield(token: string, amount: Amount, toAddress: string): Promise<{
        txHash: string;
    }>;
    /** Action builders are pure and exported for tests. */
    actionsShield(token: string, amount: Amount): readonly [{
        readonly type: "deposit";
        readonly token: string;
        readonly amount: string;
    }];
    actionsTransfer(token: string, amount: Amount, recipient: string): readonly [{
        readonly type: "transfer";
        readonly token: string;
        readonly amount: string;
        readonly recipient: string;
    }];
    actionsWithdraw(token: string, amount: Amount, recipient: string): readonly [{
        readonly type: "withdraw";
        readonly token: string;
        readonly amount: string;
        readonly recipient: string;
    }];
    private invoke;
    private requireAddress;
}
/**
 * Turn a raw wallet error into something a payer can act on.
 *
 * The one everybody hits first is NOT_REGISTERED: every pool user publishes a
 * viewing key on-chain once, and until that lands the pool will not accept a
 * deposit. Wallets do it as part of their own first shield, so the fix is a
 * one-time action in the wallet rather than anything this app can sign for.
 */
export declare function explainWalletError(err: unknown, action: "shield" | "privateTransfer" | "unshield"): string;
export {};
