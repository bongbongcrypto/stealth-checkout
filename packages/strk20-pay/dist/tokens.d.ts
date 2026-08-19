import type { Amount } from "./types.js";
export interface TokenInfo {
    address: string;
    decimals: number;
}
/** Well-known tokens (same addresses on mainnet and Sepolia). Extend via config. */
export declare const TOKENS: Record<string, TokenInfo>;
export declare function resolveToken(symbolOrAddress: string, registry?: Record<string, TokenInfo>): TokenInfo;
/** Decimal-string amount → integer units for the token. Pure bigint math. */
export declare function amountToUnits(amount: Amount, decimals: number): bigint;
export declare function unitsToAmount(units: bigint, decimals: number): Amount;
/** Amounts cross the Wallet API as hex felts in the token's smallest unit. */
export declare function amountToFelt(amount: Amount, decimals: number): string;
