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
  // Own properties only: a plain lookup finds "toString" and "__proto__" on
  // Object.prototype and hands back a TokenInfo with undefined fields.
  const known = Object.prototype.hasOwnProperty.call(registry, symbolOrAddress)
    ? registry[symbolOrAddress]
    : undefined;
  if (
    known &&
    typeof known.address === "string" &&
    /^0x[0-9a-fA-F]+$/.test(known.address) &&
    Number.isInteger(known.decimals) &&
    known.decimals >= 0 &&
    known.decimals <= 36
  ) {
    return known;
  }
  // Never guess decimals. Assuming 18 for a 6-decimal token such as USDC
  // builds a transfer for a million million times the intended amount, and
  // the payer signs it. Make the caller declare it.
  throw new Error(
    `Unknown token "${symbolOrAddress}". Register it first: ` +
      `resolveToken("${symbolOrAddress}", { ...TOKENS, MYTOKEN: { address, decimals } }), ` +
      `or pass a registry entry via the tokens option. Decimals are never assumed.`,
  );
}

/** Decimal-string amount → integer units for the token. Pure bigint math. */
export function amountToUnits(amount: Amount, decimals: number): bigint {
  const s = String(amount).trim();
  // One dot, digits only, non-empty. "1.2.3" used to parse as 1.2, and "" as 0.
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${JSON.stringify(amount)}`);
  const [ip = "0", fp = ""] = s.split(".");
  if (fp.length > decimals) {
    throw new Error(`Invalid amount: ${amount} has more than ${decimals} decimal places`);
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
