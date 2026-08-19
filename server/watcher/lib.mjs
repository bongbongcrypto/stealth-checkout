// Pure logic for the invoice watcher: no I/O, fully unit-testable.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Starknet selector constants (sn_keccak of the name: stable, protocol-wide). */
export const SELECTORS = {
  balanceOf: "0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e",
  // ERC-20 Transfer event key (Cairo1 OZ / standard tokens)
  transferEvent: "0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9",
};

/** Well-known token addresses (same on mainnet and Sepolia for STRK/ETH). */
export const TOKENS = {
  STRK: { address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", decimals: 18 },
  ETH: { address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", decimals: 18 },
};

/** Decimal string → integer units for a given decimals count. */
export function toUnits(amount, decimals) {
  const [ip = "0", fp = ""] = String(amount).trim().split(".");
  if (!/^\d+$/.test(ip || "0") || !/^\d*$/.test(fp) || fp.length > decimals) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  return BigInt(ip || "0") * 10n ** BigInt(decimals) + BigInt(fp.padEnd(decimals, "0") || "0");
}

/** starknet_call balanceOf returns a u256 as [low, high] felts. */
export function u256FromCallResult(result) {
  if (!Array.isArray(result) || result.length < 1) throw new Error("Empty call result");
  const low = BigInt(result[0]);
  const high = result.length > 1 ? BigInt(result[1]) : 0n;
  return low + (high << 128n);
}

/** Normalize a felt/address to 0x + lowercase without leading zeros (for comparisons). */
export function normFelt(value) {
  return "0x" + BigInt(value).toString(16);
}

export const INVOICE_STATES = ["watching", "paid", "expired"];

/**
 * Decide the next state of one invoice given its on-chain balance.
 * Payment rule: the invoice's fresh address holds >= the invoiced amount.
 */
export function evaluateInvoice(invoice, balanceUnits, now = Date.now()) {
  if (invoice.status !== "watching") return invoice;
  if (invoice.expiresAt && now > invoice.expiresAt) {
    return { ...invoice, status: "expired", expiredAt: now };
  }
  if (balanceUnits >= toUnits(invoice.amount, invoice.decimals)) {
    return { ...invoice, status: "paid", confirmedAt: now, balanceUnits: balanceUnits.toString() };
  }
  return invoice;
}

/** Webhook body + HMAC signature (hex). Verify with verifySignature on the merchant side. */
export function signPayload(secret, body) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret, body, signature) {
  const expected = Buffer.from(signPayload(secret, body), "hex");
  const got = Buffer.from(String(signature ?? ""), "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** JSON-RPC request body for a balanceOf call at the latest block. */
export function balanceOfRequest(tokenAddress, holderAddress, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "starknet_call",
    params: [
      { contract_address: tokenAddress, entry_point_selector: SELECTORS.balanceOf, calldata: [holderAddress] },
      "latest",
    ],
  };
}

/**
 * Best-effort tx-hash discovery: request body for Transfer events to `toAddress`.
 * Keys filter: [ [Transfer], [] (from: any), [to] ]. Some RPCs cap key filters:
 * callers must treat a miss as "hash unknown", never as "not paid".
 */
export function transferEventsRequest(tokenAddress, toAddress, fromBlock, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "starknet_getEvents",
    params: [
      {
        address: tokenAddress,
        keys: [[SELECTORS.transferEvent], [], [normFelt(toAddress)]],
        from_block: { block_number: fromBlock },
        to_block: "latest",
        chunk_size: 100,
      },
    ],
  };
}

/** Pick the tx hash of the first Transfer event whose `to` matches. */
export function txHashFromEvents(eventsResult, toAddress) {
  const target = normFelt(toAddress);
  for (const ev of eventsResult?.events ?? []) {
    const keys = ev.keys ?? [];
    // keys = [selector, from, to] for standard tokens; tolerate data-borne layouts by also checking data[1]
    const candidates = [keys[2], ev.data?.[1]].filter(Boolean).map(normFelt);
    if (candidates.includes(target)) return ev.transaction_hash;
  }
  return undefined;
}
