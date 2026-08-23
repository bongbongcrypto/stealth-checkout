import type { Amount, Network } from "../types.js";
import { type WalletAdapter } from "./adapter.js";
import { type TokenInfo } from "../tokens.js";
/** Wallet-API version that introduced the STRK20 methods (Ready, Xverse). */
export declare const MIN_STRK20_WALLET_API = "0.10.3";
/** Pool notes become spendable this many blocks after the deposit lands. */
export declare const MATURITY_BLOCKS = 10;
/** The STRK20 privacy pool, which charges the flat per-operation fee. */
/** Voyager has a separate host per network; one URL for both 404s on one. */
export declare const EXPLORER_BASE: Record<Network, string>;
export declare const POOL_ADDRESS: Record<Network, string>;
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
    /** Voyager, on the network this adapter is actually connected to. */
    explorerUrl(kind: "tx" | "address", value: string): string | null;
    private readonly rpcUrl;
    private readonly registry;
    private readonly preferWallet;
    private readonly discoveryTimeoutMs;
    private account;
    private shieldedAtBlock;
    private feeCache;
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
    shieldedBalance(token: string): Promise<Amount | null>;
    /**
     * Read the pool's flat fee. It is a real charge that no STRK20 documentation
     * mentions: we found it by calling the contract. Cached because it does not
     * move, and returned as null rather than zero when unreadable, so a caller
     * can say "unknown" instead of quietly promising the payer too low a total.
     */
    /**
     * The pool's flat fee, denominated in STRK.
     *
     * `get_fee_amount()` takes no arguments, so the pool cannot be charging a
     * different fee per token: there is one figure, and it is STRK. Decoding it
     * with the INVOICE's decimals and captioning it with the invoice's symbol
     * printed "6 ETH" on an ETH invoice, which is neither the right unit nor a
     * number anyone should add to a total. A non-STRK invoice gets null instead:
     * unknown is the honest answer until the denomination is confirmed.
     */
    poolFee(token: string): Promise<Amount | null>;
    shield(token: string, amount: Amount): Promise<{
        txHash: string;
    }>;
    /**
     * Wait until the notes created by our last shield are spendable. Without this
     * a payment fires one block after the deposit and cannot succeed, because a
     * pool note only matures after MATURITY_BLOCKS.
     */
    awaitMaturity(onProgress?: (blocksLeft: number) => void): Promise<void>;
    private blockOfTx;
    private currentBlock;
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
/**
 * The Wallet API's own error codes, which are the only reliable way to tell
 * what a wallet did before it failed.
 *
 * Two rounds of this project tried to answer that by matching words in the
 * message. The first matched too much and re-sent payments; the second matched
 * too little and missed `USER_REFUSED_OP` - the actual code, number 113,
 * declared in `@starknet-io/starknet-types-0103` right here in node_modules -
 * so an ordinary Reject left the payer locked out of their own invoice.
 *
 * @see node_modules/@starknet-io/starknet-types-0103/dist/types/wallet-api/errors.d.ts
 */
export declare const WALLET_ERROR_CODES: {
    readonly NOT_ERC20: 111;
    readonly UNLISTED_NETWORK: 112;
    readonly USER_REFUSED_OP: 113;
    readonly INVALID_REQUEST_PAYLOAD: 114;
    readonly ACCOUNT_ALREADY_DEPLOYED: 115;
    readonly DEPLOYMENT_DATA_NOT_AVAILABLE: 116;
    readonly CHAIN_ID_NOT_SUPPORTED: 117;
    readonly NOT_REGISTERED: 118;
    readonly INSUFFICIENT_PRIVATE_BALANCE: 119;
    readonly PRIVACY_LEAK: 120;
    readonly API_VERSION_NOT_SUPPORTED: 162;
    readonly UNKNOWN_ERROR: 163;
};
/**
 * The message a wallet wrote, whatever shape it wrapped it in.
 *
 * The Wallet API declares every error as a plain `{ code, message }` object,
 * not an `Error`. Reading it with `err instanceof Error ? err.message :
 * String(err)` therefore produced the literal text "[object Object]", which
 * showed that to the payer and killed every prose branch below it at once.
 */
export declare function walletErrorMessage(err: unknown, seen?: Set<unknown>): string;
/**
 * Every numeric code anywhere in the error, outermost first.
 *
 * Breadth-first over all three links, not a chain of `??` down one of them: a
 * JSON-RPC envelope puts its transport code outside and the wallet's real code
 * in `data`, and a single-path walk either stopped at the envelope or, when a
 * string sat in `cause`, gave up before reaching the object beside it.
 */
export declare function walletErrorCodes(err: unknown): number[];
/**
 * The code that describes what the WALLET did, preferring one this protocol
 * defines over a transport code that merely wrapped it.
 */
export declare function walletErrorCode(err: unknown): number | null;
/**
 * Could this error have followed a transaction reaching the network?
 *
 * Answered from the code when there is one, because that is a fact the wallet
 * asserts rather than prose it happens to have written. The message is only a
 * fallback for wallets that send no code, and it stays narrow: anything
 * unrecognised is treated as "possibly submitted", which costs a payer one
 * extra confirmation and never costs them a second payment.
 */
export declare function didNotSubmit(err: unknown): boolean;
/**
 * Did the wallet tell us the user turned it down? Message-based, and used only
 * for wallets that attach no code, and for the wording of the explanation.
 *
 * `USER_REFUSED_OP` is matched without a word boundary after the phrase for a
 * reason: `\b` does not match between `D` and `_`, so the boundary version
 * silently failed on the one string the spec actually defines.
 */
export declare function userRefused(err: unknown): boolean;
export declare function explainWalletError(err: unknown, action: "shield" | "privateTransfer" | "unshield"): string;
export {};
