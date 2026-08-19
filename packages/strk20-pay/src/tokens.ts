import type { Amount } from "./types.js";

export interface TokenInfo {
  address: string;
  decimals: number;
}

/** Well-known tokens (same addresses on mainnet and Sepolia). Extend via config. */
export const TOKENS: Record<string, TokenInfo> = {
  STRK: { address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", decimals: 18 },
  ETH: { address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", decimals: 18 },
};

export function resolveToken(symbolOrAddress: string, registry: Record<string, TokenInfo> = TOKENS): TokenInfo {
  const known = registry[symbolOrAddress];
  if (known) return known;
  if (/^0x[0-9a-fA-F]+$/.test(symbolOrAddress)) return { address: symbolOrAddress, decimals: 18 };
  throw new Error(`Unknown token "${symbolOrAddress}" — register it with an address and decimals.`);
}

/** Decimal-string amount → integer units for the token. Pure bigint math. */
export function amountToUnits(amount: Amount, decimals: number): bigint {
  const [ip = "0", fp = ""] = String(amount).trim().split(".");
  if (!/^\d+$/.test(ip || "0") || !/^\d*$/.test(fp) || fp.length > decimals) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  return BigInt(ip || "0") * 10n ** BigInt(decimals) + BigInt(fp.padEnd(decimals, "0") || "0");
}

export function unitsToAmount(units: bigint, decimals: number): Amount {
  const one = 10n ** BigInt(decimals);
  const ip = units / one;
  const fp = (units % one).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fp ? `${ip}.${fp}` : ip.toString();
}

/** Amounts cross the Wallet API as hex felts in the token's smallest unit. */
export function amountToFelt(amount: Amount, decimals: number): string {
  return `0x${amountToUnits(amount, decimals).toString(16)}`;
}
