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

export const INVOICE_STATES = [
  "reserving", // POST in flight: the id and address are claimed, nothing is watched yet
  "watching", // live, accepting payment
  "paid", // settled in full, before the deadline
  "paid_late", // settled in full, after the deadline but inside the grace window
  "underpaid", // deadline passed with some money received, but not enough
  "expired", // deadline passed with nothing received
  "cancelled", // withdrawn by the merchant before anything arrived
  "needs_reregistration", // pre-baseline row: cannot be judged safely
];

/** Money is in and the order can ship. */
export const SETTLED_STATES = new Set(["paid", "paid_late"]);

/**
 * Two questions that look alike and are not, kept apart on purpose. Merging
 * them is how "fixed in one place, still broken in the other" happens: the
 * first is about handing a link to a payer, the second about freeing an id and
 * address for reuse. An underpaid invoice answers them differently, because
 * real money is already sitting at its address.
 */

/** Never offer these to a payer: the watcher will not confirm them. */
export const UNPAYABLE_STATES = new Set([
  "reserving",
  "expired",
  "cancelled",
  "needs_reregistration",
  "underpaid",
  "paid",
  "paid_late",
]);

/** Only these may be deleted. Deleting a row with funds at its address would
 * release that address for reuse and let the stranded money settle a later
 * invoice. */
export const DELETABLE_STATES = new Set(["reserving", "expired", "needs_reregistration"]);

/**
 * How long after the deadline a payment still counts. Payers hit "pay" at
 * 23:59, wallets queue, chains reorg: dropping the money on the floor at the
 * stroke of the deadline is the single most expensive way to be right.
 */
export const LATE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a `watching` invoice with no deadline of its own is watched before
 * the poller stops spending RPC calls on it. Without this, an invoice created
 * without `expiresAt` was immortal: never overdue, so never expired, polled
 * every cycle for the life of the process, and undeletable because only
 * terminal rows may be released.
 */
export const NO_DEADLINE_MAX_WATCH_MS = 30 * 24 * 60 * 60 * 1000;

/** The deadline this invoice is actually judged against. */
export function effectiveDeadline(invoice) {
  if (typeof invoice?.expiresAt === "number") return invoice.expiresAt;
  if (typeof invoice?.createdAt === "number") return invoice.createdAt + NO_DEADLINE_MAX_WATCH_MS;
  return null; // nothing to judge against: never auto-expire, but see cancel
}

/** Should the poller still spend an RPC call on this row? */
export function shouldPoll(invoice, now = Date.now()) {
  // A `watching` row is ALWAYS polled. Retiring it is the poller's job, and
  // gating that on a window meant a watcher that was down across the window
  // came back to a row that would never be looked at again: not polled, not
  // deletable, not cancellable once anything had arrived. Stuck forever.
  // `evaluateInvoice` decides its fate; this only decides whether to look.
  if (invoice?.status === "watching") return true;
  if (invoice?.status !== "expired" && invoice?.status !== "underpaid") return false;
  // Keep looking during the grace window, and only there: polling settled or
  // abandoned rows forever turns one busy merchant into an RPC bill.
  const since = invoice.expiredAt ?? invoice.expiresAt ?? 0;
  return now - since <= LATE_GRACE_MS;
}

/**
 * The single test for "can this row be judged safely?". restore() and
 * evaluateInvoice MUST share it: when they drifted apart, a baseline of the
 * number 0 passed one and failed the other, so the row was watched forever
 * while every poll threw.
 */
export function hasUsableBaseline(row) {
  return typeof row?.baselineUnits === "string" && /^\d+$/.test(row.baselineUnits);
}

/**
 * Compare two Starknet addresses by value. Text form is not canonical: the
 * same address appears with or without leading zeros and in either case, and
 * comparing the strings made a re-rendered address look like a new one.
 */
export function sameAddress(a, b) {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

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
export function evaluateInvoice(invoice, balanceUnits, now = Date.now(), receivedOverride = null) {
  if (!shouldPoll(invoice, now)) return invoice;

  // A missing baseline must never mean zero. Rows written by an older build
  // have no baseline at all, and defaulting them to zero silently restores
  // absolute-balance semantics: the very bug this function exists to prevent.
  if (!hasUsableBaseline(invoice)) {
    throw new Error(
      `invoice ${invoice.id} has no usable baseline (${JSON.stringify(invoice.baselineUnits)}); ` +
        "re-register it so a baseline is captured before it can be confirmed",
    );
  }
  const baseline = BigInt(invoice.baselineUnits);
  // `receivedOverride` is the sum of transfers INTO this address since it was
  // registered, which is what the payer actually sent. The balance delta is a
  // fallback, and it is only equal to that while nobody has moved money out:
  // a merchant sweeping the address made a payer's full payment read as
  // nothing at all, because the balance had gone back down.
  const received = receivedOverride === null ? balanceUnits - baseline : receivedOverride;
  const target = toUnits(invoice.amount, invoice.decimals);
  if (target <= 0n) throw new Error(`invoice ${invoice.id} has a non-positive amount and can never be paid`);
  const deadline = effectiveDeadline(invoice);
  const overdue = deadline !== null && now > deadline;

  // A payment that landed before the deadline wins, even if this poll runs
  // after it. Expiring an invoice the payer already settled strands their
  // funds at an address the merchant never learns to watch.
  if (received >= target) {
    return {
      ...invoice,
      // Late still means paid, and saying which lets a merchant apply their own
      // policy instead of the watcher inventing one.
      status: overdue || invoice.status !== "watching" ? "paid_late" : "paid",
      confirmedAt: now,
      balanceUnits: balanceUnits.toString(),
      receivedUnits: received.toString(),
      // Cleared, not left over from the underpaid state this row may have
      // passed through: a payload saying paid_late AND shortfall 3 STRK at the
      // same time is one a merchant has to guess at.
      shortfallUnits: undefined,
      // Excess is the merchant's problem to resolve, but only if they are told
      // about it. Silently pocketing an overpayment is how chargebacks start.
      overpaidUnits: received > target ? (received - target).toString() : undefined,
    };
  }

  // Partial money must be visible while the invoice is still open: the payer
  // may be topping up, and the merchant should see it coming rather than
  // discover it at expiry. Track the HIGH-WATER MARK, not the current delta.
  // The balance falls again when the merchant sweeps the address, and reading
  // the current delta then said "nothing was ever received": the row flipped
  // from underpaid to expired, which is deletable, which releases the address
  // for reuse. A payer's money having arrived is not undone by moving it.
  const seenBefore = BigInt(invoice.receivedUnits ?? "0");
  const highWater = received > seenBefore ? received : seenBefore;

  if (overdue) {
    if (highWater > 0n) {
      // Already recorded at this level: nothing changed, so do not rewrite it.
      if (invoice.status === "underpaid" && highWater === seenBefore) return invoice;
      return {
        ...invoice,
        status: "underpaid",
        expiredAt: invoice.expiredAt ?? now,
        balanceUnits: balanceUnits.toString(),
        receivedUnits: highWater.toString(),
        shortfallUnits: (target - highWater).toString(),
      };
    }
    return invoice.status === "expired" ? invoice : { ...invoice, status: "expired", expiredAt: now };
  }

  if (highWater !== seenBefore) {
    return { ...invoice, balanceUnits: balanceUnits.toString(), receivedUnits: highWater.toString() };
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
  // A merchant whose WEBHOOK_SECRET env var is missing would otherwise accept
  // anything an attacker signs with the empty string.
  if (typeof secret !== "string" || secret.length === 0) return false;
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

/**
 * One CSV cell, RFC 4180 quoted and inert in a spreadsheet.
 *
 * A lone carriage return is the reason this is a named, exported function. It
 * is not a character the quoting rule looked for, so a value containing one
 * ended the record early and its remainder became a NEW row whose first cell
 * was whatever followed: `0xdead\r=cmd|'/C calc'!A0` smuggled a live formula
 * past the leading-character guard. Values reach here from a third-party RPC,
 * so "no attacker can put a CR in there" was never true.
 */
export function csvCell(value) {
  if (value === undefined || value === null) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /["\n\r,]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

/** A transaction hash we are willing to store, log, and export. */
export function isHexFelt(value, maxDigits = 64) {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{1,${maxDigits}}$`).test(value);
}

/** JSON-RPC request body for a balanceOf call at the latest block. */
export function balanceOfRequest(tokenAddress, holderAddress, id = 1, blockNumber = null) {
  return {
    jsonrpc: "2.0",
    id,
    method: "starknet_call",
    params: [
      { contract_address: tokenAddress, entry_point_selector: SELECTORS.balanceOf, calldata: [holderAddress] },
      // A baseline must be pinned to a KNOWN block. Reading it at "latest" and
      // asking a second call for the block height let the two disagree on a
      // load-balanced endpoint: the height came back lower, the event scan
      // started inside the range the baseline already covered, and a transfer
      // was counted twice - confirming an invoice nobody had paid.
      blockNumber === null ? "latest" : { block_number: blockNumber },
    ],
  };
}

/**
 * Best-effort tx-hash discovery: request body for Transfer events to `toAddress`.
 * Keys filter: [ [Transfer], [] (from: any), [to] ]. Some RPCs cap key filters:
 * callers must treat a miss as "hash unknown", never as "not paid".
 */
export function transferEventsRequest(tokenAddress, toAddress, fromBlock, id = 1, continuationToken = undefined) {
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
        ...(continuationToken ? { continuation_token: continuationToken } : {}),
      },
    ],
  };
}

/** Transfer events whose `from` is this address: money leaving it. */
export function sentEventsRequest(tokenAddress, fromAddress, fromBlock, id = 1, continuationToken = undefined) {
  return {
    jsonrpc: "2.0",
    id,
    method: "starknet_getEvents",
    params: [
      {
        address: tokenAddress,
        keys: [[SELECTORS.transferEvent], [normFelt(fromAddress)]],
        from_block: { block_number: fromBlock },
        to_block: "latest",
        chunk_size: 100,
        ...(continuationToken ? { continuation_token: continuationToken } : {}),
      },
    ],
  };
}

/** Total value transferred OUT of `fromAddress` by these events. */
export function sentFromEvents(eventsResult, fromAddress) {
  const target = normFelt(fromAddress);
  let total = 0n;
  for (const ev of eventsResult?.events ?? []) {
    const keys = ev.keys ?? [];
    const data = ev.data ?? [];
    const keyed =
      keys.length >= 2 &&
      (() => {
        try {
          return normFelt(keys[1]) === target;
        } catch {
          return false;
        }
      })();
    if (!keyed) continue;
    if (data.length < 1) return null;
    try {
      total += BigInt(data[0]) + (data.length > 1 ? BigInt(data[1]) << 128n : 0n);
    } catch {
      return null;
    }
  }
  return { units: total };
}

/**
 * Total value transferred INTO `toAddress` by these events, and the hash of
 * the first one. Standard ERC-20 layout is keys [selector, from, to] with the
 * u256 amount in data[0..1]; the older layout carries from/to in data as well,
 * so both are read and only events actually addressed to us are counted.
 *
 * Returns null when an event matches but its amount cannot be read: a partial
 * sum would be worse than no sum, because it would silently under-credit.
 */
export function receivedFromEvents(eventsResult, toAddress) {
  const target = normFelt(toAddress);
  let total = 0n;
  let txHash;
  let matched = 0;
  for (const ev of eventsResult?.events ?? []) {
    const keys = ev.keys ?? [];
    const data = ev.data ?? [];
    // Both branches have to tolerate junk. The keyed one called normFelt
    // unguarded while its sibling was wrapped, so one malformed key from an
    // RPC threw out of the whole scan.
    const keyed =
      keys.length >= 3 &&
      (() => {
        try {
          return normFelt(keys[2]) === target;
        } catch {
          return false;
        }
      })();
    const dataBorne = !keyed && data.length >= 2 && (() => {
      try {
        return normFelt(data[1]) === target;
      } catch {
        return false;
      }
    })();
    if (!keyed && !dataBorne) continue;
    // Keyed layout: amount is data[0..1]. Data-borne layout: from, to, amount.
    const lowIdx = keyed ? 0 : 2;
    if (data.length < lowIdx + 1) return null;
    let amount;
    try {
      amount = BigInt(data[lowIdx]) + (data.length > lowIdx + 1 ? BigInt(data[lowIdx + 1]) << 128n : 0n);
    } catch {
      return null;
    }
    total += amount;
    matched++;
    if (!txHash && isHexFelt(ev.transaction_hash)) txHash = ev.transaction_hash;
  }
  return { units: total, txHash, count: matched };
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
