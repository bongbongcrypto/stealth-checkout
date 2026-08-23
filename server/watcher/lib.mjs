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

/**
 * Decimal string to integer units. Strict on purpose: "" used to parse as 0,
 * which made an invoice for nothing confirm against an empty address, and
 * "1.2.3" silently became 1.2.
 */
export function toUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${JSON.stringify(amount)}`);
  const [ip = "0", fp = ""] = s.split(".");
  if (fp.length > decimals) throw new Error(`Invalid amount: ${amount} has more than ${decimals} decimal places`);
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
 *
 * Payment is a DELTA against the baseline captured when the invoice was
 * registered, never the absolute balance. An address can already hold funds:
 * it needs STRK to pay for its own deployment before a merchant can sweep it,
 * merchants reuse addresses by mistake, and airdrops happen. Confirming on the
 * absolute balance marks such an invoice paid the instant it is created, and
 * the merchant ships goods nobody paid for.
 */
export function evaluateInvoice(invoice, balanceUnits, now = Date.now()) {
  if (invoice.status !== "watching") return invoice;

  const baseline = BigInt(invoice.baselineUnits ?? "0");
  const received = balanceUnits - baseline;
  const target = toUnits(invoice.amount, invoice.decimals);
  const paid = received >= target;

  // A payment that landed before the deadline wins, even if this poll runs
  // after it. Expiring an invoice the payer already settled strands their
  // funds at an address the merchant never learns to watch.
  if (paid) {
    return {
      ...invoice,
      status: "paid",
      confirmedAt: now,
      balanceUnits: balanceUnits.toString(),
      receivedUnits: received.toString(),
    };
  }
  if (invoice.expiresAt && now > invoice.expiresAt) {
    return { ...invoice, status: "expired", expiredAt: now };
  }
  return invoice;
}

/**
 * Sign `timestamp.body` rather than the body alone, so a captured delivery
 * stops verifying once it ages out. Send the timestamp in X-Spay-Timestamp.
 */
export function signPayload(secret, body, timestamp) {
  if (timestamp === undefined) throw new Error("signPayload requires a timestamp (seconds)");
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Verify a delivery. Rejects anything outside `toleranceSec` (default five
 * minutes) so a leaked webhook cannot be replayed later, and compares in
 * constant time. Callers should ALSO dedupe on the delivery id.
 */
export function verifySignature(secret, body, signature, timestamp, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  let expected;
  try {
    expected = Buffer.from(signPayload(secret, body, ts), "hex");
  } catch {
    return false;
  }
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
