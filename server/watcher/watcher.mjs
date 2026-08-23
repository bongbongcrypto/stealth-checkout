#!/usr/bin/env node
// Invoice watcher: watches per-invoice receive addresses over public RPC and
// fires signed webhooks when a payment lands. This is the piece that makes
// accepting private payments headless: no proving, no discovery service,
// nothing beyond a JSON-RPC endpoint.
//
//   WATCHER_RPC=https://rpc.starknet.lava.build \
//   WEBHOOK_SECRET=whsec_xxx node server/watcher/watcher.mjs
//
// API (merchant-facing, bind localhost or put behind your own auth):
//   POST   /invoices                {id?, token | tokenAddress+decimals, amount, receiveAddress, expiresAt?}
//                                   send Idempotency-Key to make retries safe
//   GET    /invoices                every invoice, newest first
//   GET    /invoices.csv            the same rows as CSV, for reconciliation
//   GET    /invoices/:id            one invoice
//   DELETE /invoices/:id            release a reserving / expired / needs_reregistration row
//   POST   /invoices/:id/redeliver  re-queue this invoice's webhook
//   GET    /healthz                 unauthenticated liveness (also /public/healthz)
//
// Payer-facing (unauthenticated, needs the invoice id AND its address, which
// is exactly what a payment link carries):
//   GET    /public/invoices/:id?to=0x…   the invoice terms, so a hosted page
//                                        does not have to trust its own URL

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DELETABLE_STATES,
  INVOICE_STATES,
  UNPAYABLE_STATES,
  LATE_GRACE_MS,
  SETTLED_STATES,
  TOKENS,
  balanceOfRequest,
  csvCell,
  isHexFelt,
  receivedFromEvents,
  sentEventsRequest,
  sentFromEvents,
  evaluateInvoice,
  hasUsableBaseline,
  normFelt,
  sameAddress,
  shouldPoll,
  signPayload,
  toUnits,
  transferEventsRequest,
  txHashFromEvents,
  u256FromCallResult,
} from "./lib.mjs";

const RPC_URL = process.env.WATCHER_RPC ?? "https://rpc.starknet.lava.build";
const PORT = Number(process.env.WATCHER_PORT ?? 8787);
const POLL_MS = Number(process.env.WATCHER_POLL_MS ?? 15_000);
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
/** Required. Every request must carry `Authorization: Bearer <token>`. */
const API_TOKEN = process.env.WATCHER_TOKEN ?? "";
/** Exact origin allowed to call this from a browser. No wildcard. */
const ALLOWED_ORIGIN = process.env.WATCHER_ORIGIN ?? "";
/**
 * Extra Host header values to accept, comma separated. Needed only when the
 * watcher sits behind a proxy or tunnel that forwards the original hostname.
 */
const ALLOWED_HOSTS = (process.env.WATCHER_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const STORE_PATH = process.env.WATCHER_STORE ?? fileURLToPath(new URL("./invoices.json", import.meta.url));
/** Give up after this many webhook attempts. The row stays redeliverable. */
const WEBHOOK_MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 8);
/** And after this many manual redeliveries, stop obliging. */
const WEBHOOK_MAX_REDELIVERIES = Number(process.env.WEBHOOK_MAX_REDELIVERIES ?? 20);

/**
 * Replayed POST /invoices calls, keyed by Idempotency-Key. A merchant's retry
 * after a timeout used to hit "Invoice already exists" and read as a failure,
 * so orders were created twice or not at all.
 *
 * Each entry stores a fingerprint of the request that first used the key, so a
 * key cannot be reused for a DIFFERENT invoice: keying on an internal order id
 * is the natural integration, and returning the old 10 STRK row for a new 500
 * STRK request would have the merchant ship 500 STRK of goods against it.
 * Persisted with the ledger, because the retry a client is most likely to send
 * is the one after a crash.
 */
const idempotency = new Map();
/** Keys currently mid-create, so two concurrent POSTs cannot both proceed. */
const idempotencyInFlight = new Map();
const IDEMPOTENCY_MAX = 10_000;

/** @type {Map<string, any>} */
const invoices = new Map();
let rpcId = 0;

async function rpc(body) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  return json.result;
}

async function currentBlock() {
  return rpc({ jsonrpc: "2.0", id: ++rpcId, method: "starknet_blockNumber", params: [] });
}

let polling = false;

/** Guarded so two cycles never confirm the same invoice and double-fire. */
export async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    await pollOnce();
    await drainWebhooks();
  } finally {
    polling = false;
  }
}

async function pollOnce() {
  for (const [id, inv] of invoices) {
    // Expired and underpaid rows keep being polled through the grace window:
    // money that arrives a minute after the deadline is still the payer's
    // money, and refusing to look for it does not make it go away.
    if (!shouldPoll(inv)) continue;
    try {
      const result = await rpc(balanceOfRequest(inv.tokenAddress, inv.receiveAddress, ++rpcId));
      const balance = u256FromCallResult(result);
      // What the payer actually sent, summed from transfers into this address
      // since it was registered. The balance delta is only a fallback: it
      // cannot see money that has already been moved out, so a merchant
      // sweeping the address made a full payment read as nothing.
      // A create whose blockNumber call failed once left the row on the weaker
      // accounting forever, with no route to fix it. Repair it on the first
      // poll that can: the current head is a safe start, because anything
      // earlier is already inside the baseline.
      if (typeof inv.createdBlock !== "number") {
        const head = await currentBlock().catch(() => null);
        // The same guard the normal write below uses. Without it a cancel or a
        // DELETE landing during that await was undone by this write: a
        // cancelled invoice went back to accepting payment, and a deleted row
        // came back with its address still locked.
        if (typeof head === "number" && invoices.get(id) === inv) {
          invoices.set(id, { ...inv, createdBlock: head });
          await persist();
          log(`${id} backfilled createdBlock=${head}; event accounting is on from here`);
          continue; // judge it on the next cycle, with the scan available
        }
        if (invoices.get(id) !== inv) continue; // it changed under us; leave it alone
      }
      const inflow = await totalReceived(inv).catch((err) => {
        log(`${id} event scan failed (${err.message}); falling back to the balance delta`);
        return null;
      });
      // Whichever saw more. The event sum is right after a sweep, where the
      // balance has gone back down; the balance delta is right when the event
      // filter matches nothing, which a token with an unusual event layout
      // does silently. Taking the larger can only ever fail towards crediting
      // a payer for money that did arrive, never away from it.
      const delta = balance - BigInt(inv.baselineUnits);
      // The event sum may exceed the delta only because money left again after
      // arriving. Anything beyond that is the two measurements disagreeing,
      // and crediting the larger of two numbers we cannot reconcile is how an
      // invoice gets confirmed on money that was already there. Cap the excess
      // at what has demonstrably flowed out.
      let received = null;
      let unreconciled = false;
      if (inflow !== null) {
        const outflow = await totalSent(inv).catch(() => null);
        const credible = outflow === null ? delta : delta + outflow.units;
        received = inflow.units > delta ? (inflow.units > credible ? credible : inflow.units) : delta;
        if (inflow.units > credible) {
          // Two measurements of the same address that do not add up. Crediting
          // the lower figure and letting the deadline expire the row released
          // an address a payer's money had genuinely reached. Hold it open
          // instead: a human can reconcile it, and nothing can reuse it.
          unreconciled = true;
          log(
            `${id} WARNING: transfers in (${inflow.units}) exceed balance growth plus transfers out ` +
              `(${credible}); NOT expiring this row until it reconciles. Check this address.`,
          );
        }
      }
      if (inflow !== null && inflow.count === 0 && delta > 0n) {
        log(`${id} note: no matching transfer events; judging on the balance delta instead`);
      }
      // An unreconciled row keeps its deadline at bay rather than being
      // retired on numbers we do not trust - for this evaluation only, never
      // by editing the row.
      const next = evaluateInvoice(inv, balance, Date.now(), received, unreconciled && inv.status === "watching");
      if (next === inv) continue;
      // Never write back onto a row that changed underneath us: this loop
      // awaits twice, and a DELETE or a cancel landing in between used to be
      // undone by the write, resurrecting a row nobody had a record of.
      const current = invoices.get(id);
      if (current !== inv) {
        log(`${id} changed while polling; skipping this write`);
        continue;
      }
      if (inflow?.txHash && !next.txHash) next.txHash = inflow.txHash;
      invoices.set(id, next);
      await persist();
      if (next.status !== inv.status) {
        if (SETTLED_STATES.has(next.status)) {
          next.txHash ??= await findTxHash(next).catch(() => undefined);
          await persist();
          queueWebhook(next, "payment.confirmed");
        } else if (next.status === "underpaid") {
          // Silence here is the expensive option: the payer's money is sitting
          // at an address only the merchant can sweep.
          queueWebhook(next, "payment.underpaid");
        }
        log(`${id} → ${next.status}${next.txHash ? ` (${next.txHash.slice(0, 12)}…)` : ""}`);
      } else if (next.receivedUnits !== inv.receivedUnits) {
        log(`${id} partial: ${next.receivedUnits} / ${toUnits(inv.amount, inv.decimals)} units`);
      }
      // Even with event accounting, a swept address is worth saying out loud:
      // the merchant has moved a payer's money before the invoice resolved.
      if (balance < BigInt(inv.baselineUnits) + BigInt(next.receivedUnits ?? "0")) {
        log(`${id} note: this address holds less than it received; it was swept while still being watched`);
      }
    } catch (err) {
      // RPC refusal is not a chain answer: keep watching, never mark unpaid.
      log(`${id} poll error: ${err.message}`);
    }
  }
}

async function findTxHash(inv) {
  const head = await currentBlock();
  const from = Math.max(0, head - 2000);
  const events = await rpc(transferEventsRequest(inv.tokenAddress, inv.receiveAddress, from, ++rpcId));
  const hash = txHashFromEvents(events, inv.receiveAddress);
  // A hash from a third-party RPC is exported to CSV and rendered as a link.
  return isHexFelt(hash) ? hash : undefined;
}

/**
 * Sum every transfer into this invoice's address since it was registered.
 * Returns null when the row predates block recording, when a page of events
 * cannot be read, or when the scan runs longer than it is worth: a partial sum
 * would under-credit the payer, which is exactly the bug this replaces.
 */
/** The mirror of totalReceived: everything that has left this address. */
async function totalSent(inv) {
  if (typeof inv.createdBlock !== "number") return null;
  let token;
  let total = 0n;
  let pages = 0;
  const seen = new Set();
  do {
    const page = await rpc(
      sentEventsRequest(inv.tokenAddress, inv.receiveAddress, inv.createdBlock + 1, ++rpcId, token),
    );
    const summed = sentFromEvents(page, inv.receiveAddress);
    if (summed === null) return null;
    total += summed.units;
    token = page?.continuation_token;
    if (token && seen.has(token)) return null;
    if (token) seen.add(token);
  } while (token && ++pages < 50);
  if (token) return null;
  return { units: total };
}

async function totalReceived(inv) {
  // Without a start block there is nothing to scan from, and scanning from
  // zero would count money that arrived before the invoice existed. The row
  // falls back to balance-delta accounting; `backfillCreatedBlock` repairs it
  // so that is temporary rather than permanent.
  if (typeof inv.createdBlock !== "number") return null;
  let token;
  let total = 0n;
  let txHash;
  let matched = 0;
  let pages = 0;
  const seenTokens = new Set();
  do {
    const page = await rpc(
      // createdBlock + 1, NOT createdBlock. The baseline balance is read at
      // `latest`, which is that same block, so scanning from it counted every
      // transfer in it TWICE: once inside the baseline and once as a payment.
      // A pre-funded address whose funds arrived in the registration block
      // confirmed instantly with nobody having paid, which is precisely the
      // bug the baseline exists to prevent.
      transferEventsRequest(inv.tokenAddress, inv.receiveAddress, inv.createdBlock + 1, ++rpcId, token),
    );
    const summed = receivedFromEvents(page, inv.receiveAddress);
    if (summed === null) return null; // an unreadable amount: do not guess
    total += summed.units;
    matched += summed.count;
    txHash ??= summed.txHash;
    token = page?.continuation_token;
    // A repeated cursor means the same page again, and adding it again is a
    // silent over-credit.
    if (token && seenTokens.has(token)) return null;
    if (token) seenTokens.add(token);
  } while (token && ++pages < 50);
  // Still paginating after fifty pages means something is wrong with the
  // filter, not that the payer sent that many transfers.
  if (token) return null;
  return { units: total, txHash, count: matched };
}

/**
 * Mark a webhook as owed. The queue lives on the invoice row itself, so it is
 * written to disk by the same persist() as everything else: a restart used to
 * drop every in-flight retry, because the retries were setTimeout callbacks in
 * a process that no longer existed. The merchant never heard about the payment
 * and the money looked unpaid forever.
 */
function queueWebhook(inv, event) {
  const row = invoices.get(inv.id) ?? inv;
  // A NEW id for a new event. Reusing the previous one meant an invoice that
  // went underpaid and was then topped up sent payment.confirmed under the id
  // its payment.underpaid had already used, and every merchant deduping on
  // deliveryId (as the docs instruct) discarded the confirmation. Money in,
  // order never shipped. Only a redelivery of the SAME event keeps its id.
  row.webhook = {
    event,
    deliveryId: `dlv_${randomUUID()}`,
    attempts: 0,
    nextAttemptAt: Date.now(),
    lastError: undefined,
  };
  invoices.set(row.id, row);
  void persist();
}

/** Deliveries in flight right now, so two drains cannot send the same one. */
const sending = new Set();

/** Send everything that is due. Called from the same loop as the poller. */
async function drainWebhooks(now = Date.now()) {
  for (const inv of [...invoices.values()]) {
    const w = inv.webhook;
    if (!w || w.deliveredAt || w.attempts >= WEBHOOK_MAX_ATTEMPTS) continue;
    if (w.nextAttemptAt > now) continue;
    await deliverWebhook(inv);
  }
}

async function deliverWebhook(inv) {
  // Server configuration only. An invoice can never name its own endpoint.
  if (!WEBHOOK_URL) return;
  if (!WEBHOOK_SECRET) {
    // Sending unsigned would let anyone who can reach the merchant's endpoint
    // forge a confirmation. Refuse instead of downgrading silently.
    log(`webhook ${inv.id} NOT SENT: WEBHOOK_SECRET is unset, refusing to send unsigned`);
    return;
  }
  const row = invoices.get(inv.id) ?? inv;
  const w = row.webhook ?? { event: "payment.confirmed", deliveryId: `dlv_${randomUUID()}`, attempts: 0 };
  row.webhook = w;
  // The poll loop's drain and a manual redeliver can overlap, and without this
  // the same delivery went out twice, both labelled "attempt 1", with the
  // backoff state of whichever finished last.
  if (sending.has(row.id)) return;
  sending.add(row.id);
  const attempt = w.attempts + 1;
  const body = JSON.stringify({
    event: w.event,
    deliveryId: w.deliveryId, // stable across retries: merchants dedupe on this
    attempt,
    invoice: {
      id: row.id,
      token: row.token,
      amount: row.amount,
      status: row.status,
      receiveAddress: row.receiveAddress,
      txHash: row.txHash ?? null,
      receivedUnits: row.receivedUnits ?? null,
      shortfallUnits: row.shortfallUnits ?? null,
      overpaidUnits: row.overpaidUnits ?? null,
      confirmedAt: row.confirmedAt ?? null,
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Spay-Timestamp": String(timestamp),
        "X-Spay-Signature": signPayload(WEBHOOK_SECRET, body, timestamp),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    w.attempts = attempt;
    w.deliveredAt = Date.now();
    w.lastError = undefined;
    row.webhookDeliveredAt = w.deliveredAt;
    invoices.set(row.id, row);
    await persist();
  } catch (err) {
    w.attempts = attempt;
    w.lastError = err.message;
    // Exponential backoff with a ceiling, persisted, so the next drain in this
    // process or the next one picks it up from exactly here.
    w.nextAttemptAt = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** (attempt - 1));
    invoices.set(row.id, row);
    await persist();
    log(`webhook ${row.id} attempt ${attempt} failed: ${err.message}`);
    if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
      log(`webhook ${row.id} GAVE UP after ${attempt} attempts; POST /invoices/${row.id}/redeliver to retry`);
    }
  } finally {
    sending.delete(row.id);
  }
}

/**
 * What makes two creates "the same request". Only the fields that decide what
 * is owed and where: a merchant re-sending with a different id is still asking
 * for the same invoice, but a different amount or address is not.
 */
function requestFingerprint(body) {
  const norm = (v) => {
    try {
      return normFelt(v);
    } catch {
      return String(v ?? "");
    }
  };
  // Deliberately NOT expiresAt. A dashboard computes it as `now + N hours` on
  // every click, so including it made a retry under the same key a different
  // request every time: the merchant got a 409 forever for a create that had
  // already succeeded, which is the exact failure this feature exists to
  // remove. What is owed and where it goes is the identity of a request; when
  // it lapses is not.
  return JSON.stringify([
    String(body?.amount ?? ""),
    String(body?.token ?? ""),
    String(body?.tokenAddress ?? ""),
    body?.decimals ?? null,
    norm(body?.receiveAddress),
  ]);
}

function rememberIdempotency(key, id, fingerprint) {
  idempotency.set(key, { id, fingerprint, at: Date.now() });
  // Oldest first: a long-running merchant must not grow this without bound.
  while (idempotency.size > IDEMPOTENCY_MAX) {
    idempotency.delete(idempotency.keys().next().value);
  }
}

function knownToken(symbol) {
  // Own properties only: "toString" and "__proto__" otherwise resolve to junk.
  return Object.prototype.hasOwnProperty.call(TOKENS, symbol) ? TOKENS[symbol] : undefined;
}

function resolveToken(body) {
  if (body.tokenAddress !== undefined) {
    if (typeof body.tokenAddress !== "string" || !/^0x[0-9a-fA-F]{10,64}$/.test(body.tokenAddress)) {
      throw new Error("tokenAddress must be a hex Starknet address");
    }
    if (!Number.isInteger(body.decimals) || body.decimals < 0 || body.decimals > 36) {
      throw new Error("decimals must be an integer between 0 and 36");
    }
    // The mirror of the check below, which only covered a known ADDRESS with
    // the wrong label. A known LABEL on an unknown address let an invoice be
    // watched on some other contract while the payer's page, the webhook and
    // the CSV all said STRK: the payer pays real STRK and it never confirms.
    const claimed = knownToken(body.token);
    if (claimed && !sameAddress(claimed.address, body.tokenAddress)) {
      throw new Error(`${body.token} is ${claimed.address}, not ${body.tokenAddress}`);
    }
    // Declaring the wrong decimals for a token we know would confirm an
    // invoice for "1 STRK" on a millionth of one while the webhook still
    // reports "1 STRK". Look the token up BY ADDRESS: keying on the label let
    // "strk", " STRK", or simply omitting the label walk straight past this.
    for (const [symbol, known] of Object.entries(TOKENS)) {
      if (!sameAddress(known.address, body.tokenAddress)) continue;
      if (known.decimals !== body.decimals) {
        throw new Error(`${symbol} has ${known.decimals} decimals, not ${body.decimals}`);
      }
      // The label is what the webhook, the CSV, the dashboard and the payer's
      // page all display, and nothing was checking it against the address.
      // `{token:"ETH", tokenAddress:<STRK>}` watched STRK while every screen
      // said ETH: one side ships against the wrong price, whichever way it
      // is read.
      if (body.token !== undefined && body.token !== symbol) {
        throw new Error(`tokenAddress ${body.tokenAddress} is ${symbol}, not ${body.token}`);
      }
      return { token: symbol, tokenAddress: body.tokenAddress, decimals: body.decimals };
    }
    return { token: body.token ?? "CUSTOM", tokenAddress: body.tokenAddress, decimals: body.decimals };
  }
  const known = knownToken(body.token);
  if (!known) throw new Error(`Unknown token ${body.token}; pass tokenAddress + decimals`);
  return { token: body.token, tokenAddress: known.address, decimals: known.decimals };
}

/**
 * Register an invoice. The baseline balance is read HERE, once, so payment is
 * always judged as a delta. Callers cannot choose the webhook URL: letting
 * them would turn this into an oracle that signs arbitrary bodies with the
 * merchant's secret.
 */
/**
 * Drop a reservation, and ONLY a reservation.
 *
 * These two deletes matched by id with no identity check, so a create that
 * failed after its reservation had been released and the id reused deleted the
 * live invoice that now held it - freeing its address, and leaving a payer's
 * link pointing at a row the watcher no longer had.
 */
function releaseReservation(id) {
  const row = invoices.get(id);
  if (row && row.status === "reserving") invoices.delete(id);
}

async function createInvoice(body) {
  // Type checks, not coercion: `.test()` stringifies, so ["0x0abc…"] used to
  // pass as an address and then silently never match on-chain.
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  if (typeof body.receiveAddress !== "string" || !/^0x[0-9a-fA-F]{10,64}$/.test(body.receiveAddress)) {
    throw new Error("receiveAddress must be a hex string (0x plus 10-64 digits): one fresh address per invoice");
  }
  // Not just a string: this label is exported to CSV, where a control
  // character ends the record early and turns the rest into a new row.
  if (body.token !== undefined && (typeof body.token !== "string" || !/^[\w.+-]{1,16}$/.test(body.token))) {
    throw new Error("token must be 1-16 chars of [A-Za-z0-9_.+-]");
  }
  if (body.id !== undefined && typeof body.id !== "string") throw new Error("id must be a string");
  if (body.expiresAt !== undefined && typeof body.expiresAt !== "number") {
    throw new Error("expiresAt must be a number of milliseconds since the epoch");
  }
  const { token, tokenAddress, decimals } = resolveToken(body);
  const amount = String(body.amount ?? "").trim();
  const target = toUnits(amount, decimals); // validates format
  if (target <= 0n) throw new Error("amount must be greater than zero");
  if (body.expiresAt !== undefined) {
    if (!Number.isFinite(body.expiresAt) || body.expiresAt <= 0) {
      throw new Error("expiresAt must be a positive millisecond timestamp");
    }
    // A deadline in the past mints a link that is dead before anyone opens it,
    // and the row only says so at the next poll. Seconds instead of
    // milliseconds is the usual way to get here by accident.
    if (body.expiresAt <= Date.now()) {
      throw new Error(
        `expiresAt ${body.expiresAt} is already past (now ${Date.now()}); it must be milliseconds since the epoch, in the future`,
      );
    }
  }

  const id = body.id ?? `inv_${randomUUID().slice(0, 8)}`;
  if (!/^[\w.-]{1,64}$/.test(id)) throw new Error("id must be 1-64 chars of [A-Za-z0-9_.-]");
  if (invoices.has(id)) throw new Error(`Invoice ${id} already exists`);

  // Any invoice that ever used this address, not just a live one: a late
  // payment against an expired invoice would otherwise settle its successor.
  for (const other of invoices.values()) {
    if (sameAddress(other.receiveAddress, body.receiveAddress)) {
      throw new Error(`receiveAddress was already used by invoice ${other.id}; use a fresh address`);
    }
  }

  // Reserve before awaiting: two concurrent POSTs would otherwise both pass
  // the checks above, and the second would overwrite the first, leaving the
  // first order's address unwatched.
  invoices.set(id, { id, status: "reserving", receiveAddress: body.receiveAddress, createdAt: Date.now() });

  // Height FIRST, then the balance pinned to that exact height, so the
  // baseline and the scan window can never disagree about where one ends and
  // the other begins. The old order read the balance at "latest" and the
  // height separately, and a lagging replica answering the second call put
  // money that was already inside the baseline back inside the scan.
  let createdBlock = await currentBlock().catch(() => undefined);
  let baseline;
  try {
    baseline = u256FromCallResult(
      await rpc(
        balanceOfRequest(
          tokenAddress,
          body.receiveAddress,
          ++rpcId,
          typeof createdBlock === "number" ? createdBlock : null,
        ),
      ),
    );
  } catch (err) {
    if (typeof createdBlock !== "number") {
      releaseReservation(id); // never leave a half-created row behind
      throw err;
    }
    // A node that will not serve that historical block is not a reason to
    // refuse the invoice: fall back to "latest" and to delta accounting, which
    // is what every row did before event scanning existed.
    createdBlock = undefined;
    try {
      baseline = u256FromCallResult(await rpc(balanceOfRequest(tokenAddress, body.receiveAddress, ++rpcId)));
    } catch (err2) {
      releaseReservation(id);
      throw err2;
    }
  }
  const inv = {
    id,
    token,
    tokenAddress,
    decimals,
    amount,
    receiveAddress: body.receiveAddress,
    baselineUnits: baseline.toString(),
    createdBlock: typeof createdBlock === "number" ? createdBlock : undefined,
    expiresAt: body.expiresAt === undefined ? undefined : Number(body.expiresAt),
    status: "watching",
    createdAt: Date.now(),
  };
  // The row was reserved before two awaits. A DELETE landing in that window
  // returned 200 and the merchant believed the id and address were released -
  // and then this write put the row back. Every other multi-await path in this
  // file has this guard; the one that CREATES rows did not.
  const reserved = invoices.get(id);
  if (!reserved || reserved.status !== "reserving") {
    throw new Error(`invoice ${id} was released while it was being created; create it again`);
  }
  invoices.set(inv.id, inv);
  return inv;
}

/**
 * One write at a time, and never in place.
 *
 * `persist()` is called from overlapping paths, one of them un-awaited, and a
 * bare writeFile can interleave into unparseable JSON - which `restore()` then
 * refuses to boot on, taking every repair route down with it. Serialised
 * behind a promise chain and written to a temp file that is renamed over the
 * real one, so a reader sees the old ledger or the new one and never half.
 */
let persistChain = Promise.resolve();

function persist() {
  persistChain = persistChain.then(persistNow, persistNow);
  return persistChain;
}

async function persistNow() {
  try {
    // The idempotency table rides with the ledger. It used to be memory-only,
    // so the retry a client sends after a crash - the one the feature exists
    // for - hit "invoice already exists" and read as a failure.
    const body = JSON.stringify(
      { invoices: [...invoices.values()], idempotency: [...idempotency.entries()] },
      null,
      2,
    );
    await writeFile(`${STORE_PATH}.tmp`, body);
    await rename(`${STORE_PATH}.tmp`, STORE_PATH);
  } catch (err) {
    // Loud, because the invoice-to-order mapping lives ONLY here. Losing it
    // means a paid invoice can never be matched back to an order.
    log(`PERSISTENCE FAILED (${STORE_PATH}): ${err.message}`);
  }
}

async function restore() {
  let raw;
  try {
    raw = await readFile(STORE_PATH, "utf8");
  } catch {
    return; // first run
  }
  try {
    const parsed = JSON.parse(raw);
    // Older stores are a bare array. Read both, write only the new shape.
    const invoiceList = Array.isArray(parsed) ? parsed : parsed?.invoices;
    if (!Array.isArray(invoiceList)) throw new Error("expected an array of invoices");
    for (const [key, value] of Array.isArray(parsed?.idempotency) ? parsed.idempotency : []) {
      if (typeof key === "string" && value && typeof value.id === "string") idempotency.set(key, value);
    }
    const rows = [];
    let dropped = 0;
    for (const row of invoiceList) {
      // One malformed row must not stop the process from booting: that turns a
      // hand-edit into a total outage with no repair tool.
      if (row && typeof row === "object" && typeof row.id === "string") rows.push(row);
      else dropped++;
    }
    let quarantined = 0;
    for (const row of rows) {
      // Rows from a build that predates baselines cannot be judged safely.
      // Park them rather than watching them: watching would confirm on the
      // absolute balance and pay out orders nobody paid for.
      if (row.status === "watching" && !hasUsableBaseline(row)) {
        invoices.set(row.id, { ...row, status: "needs_reregistration" });
        quarantined++;
        continue;
      }
      invoices.set(row.id, row);
    }
    log(`restored ${rows.length} invoice(s)`);
    if (dropped > 0) log(`${dropped} unreadable row(s) in the store were skipped`);
    if (quarantined > 0) {
      log(`${quarantined} invoice(s) have no baseline and were NOT resumed: DELETE then re-create them`);
      await persist(); // write the quarantine back, or the file keeps saying "watching"
    }
  } catch (err) {
    // A corrupt store must not take the process down with it: refusing to boot
    // removes DELETE, cancel and redeliver, which are the only ways to repair
    // anything. Keep the evidence, start empty, and be impossible to miss.
    // RENAME, not copy, and to a fixed name. Copying left the corrupt file in
    // place, so every restart made another copy and the next create overwrote
    // the original anyway; a crash loop made one per boot. And if the evidence
    // cannot be kept - the disk-full case that probably caused this - refuse
    // to run, because the first persist() would destroy the only copy.
    const quarantine = `${STORE_PATH}.corrupt`;
    try {
      await rename(STORE_PATH, quarantine);
    } catch (moveErr) {
      throw new Error(
        `invoice store at ${STORE_PATH} is corrupt (${err.message}) and could not be moved aside ` +
          `(${moveErr.message}). Refusing to start: continuing would overwrite the only copy of your ledger.`,
      );
    }
    log(`STORE WAS CORRUPT (${err.message}). Moved it to ${quarantine} and started EMPTY.`);
    log("Every open invoice is unknown to this process until that file is repaired and restored.");
  }
}

function log(msg) {
  console.log(`[watcher ${new Date().toISOString()}] ${msg}`);
}

/**
 * No wildcard. A wildcard plus a bearer token still lets any page the merchant
 * visits read the whole invoice ledger once that token leaks into a script.
 * Set WATCHER_ORIGIN to the exact dashboard origin, or leave it unset to
 * refuse browsers entirely.
 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGIN || origin !== ALLOWED_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // Idempotency-Key is on this list because the dashboard sends it on every
    // create. Without it the preflight failed and "Create invoice" could not
    // work cross-origin at all, while Refresh and Export CSV did - so the
    // feature looked configured and was not.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
  };
}

/** Constant-time bearer check. */
function authorized(req) {
  const header = req.headers.authorization ?? "";
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${API_TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The payer-facing route is readable from any origin, because the payer's page
 * is not the merchant's dashboard and there is no token to protect. It carries
 * no credentials, so a wildcard here grants nothing a plain fetch could not
 * already get.
 */
const PUBLIC_CORS = { "Access-Control-Allow-Origin": "*" };

function json(req, res, code, data, extraHeaders = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { "Content-Type": "application/json", ...corsHeaders(req), ...extraHeaders });
  res.end(body);
}

const CSV_COLUMNS = [
  "id",
  "status",
  "token",
  "amount",
  "receiveAddress",
  "createdAt",
  "expiresAt",
  "confirmedAt",
  "receivedUnits",
  "shortfallUnits",
  "overpaidUnits",
  "txHash",
];

function invoicesCsv() {
  const rows = [...invoices.values()].sort((a, b) => b.createdAt - a.createdAt);
  const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : "");
  const lines = [CSV_COLUMNS.join(",")];
  for (const inv of rows) {
    lines.push(
      CSV_COLUMNS.map((c) =>
        csvCell(["createdAt", "expiresAt", "confirmedAt"].includes(c) ? iso(inv[c]) : inv[c]),
      ).join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** Read a bounded body: an unbounded one is a free memory-exhaustion attack. */
async function readBody(req, limit = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("request body too large");
  }
  return raw;
}

export function makeServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    // Bound to loopback, so any other hostname reaching it is DNS rebinding:
    // a page on the internet resolving its own domain to 127.0.0.1 to talk to
    // this API from the browser. The bearer token stops it doing damage; this
    // stops it being reached at all.
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    if (host && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host) && !ALLOWED_HOSTS.includes(host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("host not allowed");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    // Health is unauthenticated and reveals nothing.
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(req, res, 200, { ok: true, watcher: true }, PUBLIC_CORS);
    }
    // The same answer under the payer-facing prefix, for callers that only
    // grant themselves that path. Identical body, identical CORS.
    if (req.method === "GET" && url.pathname === "/public/healthz") {
      return json(req, res, 200, { ok: true, watcher: true }, PUBLIC_CORS);
    }
    // The payer's view. Unauthenticated by necessity: the payer's browser has
    // no merchant token. Knowing the id is not enough, the caller must also
    // present the receive address, so this reveals nothing to someone guessing
    // ids, and everything to someone holding the payment link. It exists so a
    // hosted invoice page can take its terms from the merchant's server
    // instead of from its own query string, which the payer controls.
    const pub = url.pathname.match(/^\/public\/invoices\/([\w.-]{1,64})$/);
    if (req.method === "GET" && pub) {
      const inv = invoices.get(pub[1]);
      const to = url.searchParams.get("to") ?? "";
      if (!inv || inv.status === "reserving" || !sameAddress(inv.receiveAddress ?? "", to)) {
        return json(req, res, 404, { error: "not found" }, PUBLIC_CORS);
      }
      return json(
        req,
        res,
        200,
        {
          id: inv.id,
          token: inv.token,
          amount: inv.amount,
          decimals: inv.decimals,
          receiveAddress: inv.receiveAddress,
          status: inv.status,
          expiresAt: inv.expiresAt ?? null,
          receivedUnits: inv.receivedUnits ?? "0",
          txHash: inv.txHash ?? null,
        },
        PUBLIC_CORS,
      );
    }
    if (!API_TOKEN) {
      return json(req, res, 503, { error: "WATCHER_TOKEN is not set; the API is disabled" });
    }
    if (!authorized(req)) {
      return json(req, res, 401, { error: "missing or invalid bearer token" });
    }
    try {
      // What this watcher considers payable, so a dashboard that retypes these
      // lists can notice when it has fallen behind instead of handing a payer
      // a link to an invoice nothing is watching.
      if (req.method === "GET" && url.pathname === "/states") {
        return json(req, res, 200, {
          states: INVOICE_STATES,
          unpayable: [...UNPAYABLE_STATES],
          deletable: [...DELETABLE_STATES],
          settled: [...SETTLED_STATES],
        });
      }
      if (req.method === "GET" && url.pathname === "/invoices") {
        return json(req, res, 200, [...invoices.values()].sort((a, b) => b.createdAt - a.createdAt));
      }
      // Reconciliation. Every merchant eventually has to tie this ledger to
      // their own books, and "read the JSON" is not an answer an accountant
      // accepts.
      if (req.method === "GET" && url.pathname === "/invoices.csv") {
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="invoices.csv"',
          ...corsHeaders(req),
        });
        return res.end(invoicesCsv());
      }
      if (req.method === "POST" && url.pathname === "/invoices") {
        const key = req.headers["idempotency-key"];
        if (key !== undefined && (typeof key !== "string" || key.length > 200)) {
          throw new Error("Idempotency-Key must be a string of at most 200 characters");
        }
        const raw = (await readBody(req)) || "{}";
        const parsed = JSON.parse(raw);
        const fingerprint = key ? requestFingerprint(parsed) : null;

        if (key) {
          const prior = idempotency.get(key);
          if (prior) {
            // The key must name the SAME request. Merchants key on their own
            // order id, so reusing one for a repriced order used to return the
            // old row with a 200 and ship the new goods against it.
            if (prior.fingerprint !== fingerprint) {
              return json(req, res, 409, {
                error: `Idempotency-Key ${key} was already used for a different invoice`,
              });
            }
            const row = invoices.get(prior.id);
            if (row) return json(req, res, 200, row);
            idempotency.delete(key); // the row is gone; let the caller create it again
          }
          // Two concurrent POSTs with one key: the check and the write used to
          // straddle an await, so a double-submit produced 201 and 400.
          if (idempotencyInFlight.has(key)) {
            return json(req, res, 409, { error: `Idempotency-Key ${key} is already being processed` });
          }
          idempotencyInFlight.set(key, fingerprint);
        }
        let inv;
        try {
          inv = await createInvoice(parsed);
        } finally {
          if (key) idempotencyInFlight.delete(key);
        }
        if (key) rememberIdempotency(key, inv.id, fingerprint);
        await persist();
        log(`watching ${inv.id} -> ${inv.receiveAddress} for ${inv.amount} ${inv.token} (baseline ${inv.baselineUnits})`);
        return json(req, res, 201, inv);
      }
      // A watching invoice used to be immortal: never overdue without an
      // expiresAt, polled every cycle for the life of the process, and
      // undeletable because only terminal rows may be released. Cancelling
      // retires it without freeing its address, which is the part that must
      // never be reused.
      const cancel = url.pathname.match(/^\/invoices\/([\w.-]{1,64})\/cancel$/);
      if (req.method === "POST" && cancel) {
        const inv = invoices.get(cancel[1]);
        if (!inv) return json(req, res, 404, { error: "not found" });
        if (inv.status !== "watching") {
          return json(req, res, 409, { error: `invoice ${inv.id} is ${inv.status}; only a watching invoice can be cancelled` });
        }
        // Ask the chain, not the cached field. `receivedUnits` is only written
        // by a poll, so between a payer's transfer landing and the next cycle
        // this guard read zero and cancelled an invoice with money at its
        // address, into a state that is never polled again.
        let live;
        try {
          live = u256FromCallResult(await rpc(balanceOfRequest(inv.tokenAddress, inv.receiveAddress, ++rpcId)));
        } catch (err) {
          return json(req, res, 503, {
            error: `cannot reach the chain to check ${inv.id} for funds before cancelling it: ${err.message}`,
          });
        }
        const arrived = live - BigInt(inv.baselineUnits);
        if (arrived > 0n || BigInt(inv.receivedUnits ?? "0") > 0n) {
          return json(req, res, 409, {
            error: `invoice ${inv.id} has ${arrived > 0n ? arrived : inv.receivedUnits} units at its address; resolve it rather than cancelling it`,
          });
        }
        const next = { ...inv, status: "cancelled", cancelledAt: Date.now() };
        invoices.set(inv.id, next);
        await persist();
        log(`${inv.id} → cancelled`);
        return json(req, res, 200, next);
      }
      // Anyone who has seen a payment link can send 1 wei to its address, which
      // makes the row `underpaid`: not deletable, not cancellable, its address
      // never reusable. Without a way out, a stranger can permanently pin
      // every invoice a merchant issues, for dust. This retires the row and
      // keeps its address claimed forever, which is the part that must not
      // change: the money is still there.
      const writeOff = url.pathname.match(/^\/invoices\/([\w.-]{1,64})\/write-off$/);
      if (req.method === "POST" && writeOff) {
        const inv = invoices.get(writeOff[1]);
        if (!inv) return json(req, res, 404, { error: "not found" });
        // Only the state this was written for. It accepted `watching` too,
        // which let a merchant bury a payment the poller had not seen yet -
        // written_off is never polled again, so payment.confirmed could never
        // fire. And it accepted `expired` and `reserving`, which are DELETABLE
        // precisely because nothing arrived: converting those into a permanent
        // lock is strictly worse than the delete they already had.
        if (inv.status !== "underpaid") {
          return json(req, res, 409, {
            error: `invoice ${inv.id} is ${inv.status}; only an underpaid invoice can be written off` +
              (DELETABLE_STATES.has(inv.status) ? " (this one can simply be deleted)" : ""),
          });
        }
        // And ask the chain, exactly as cancel does. A top-up landing between
        // the last poll and this call would otherwise be buried by it.
        let live;
        try {
          live = u256FromCallResult(await rpc(balanceOfRequest(inv.tokenAddress, inv.receiveAddress, ++rpcId)));
        } catch (err) {
          return json(req, res, 503, {
            error: `cannot reach the chain to check ${inv.id} before writing it off: ${err.message}`,
          });
        }
        const arrived = live - BigInt(inv.baselineUnits);
        if (arrived >= toUnits(inv.amount, inv.decimals)) {
          return json(req, res, 409, {
            error: `invoice ${inv.id} has been paid in full since the last poll; let it settle rather than writing it off`,
          });
        }
        const next = { ...inv, status: "written_off", writtenOffAt: Date.now() };
        invoices.set(inv.id, next);
        await persist();
        log(`${inv.id} → written_off (was ${inv.status}, received ${inv.receivedUnits ?? "0"} units)`);
        return json(req, res, 200, next);
      }
      const redeliver = url.pathname.match(/^\/invoices\/([\w.-]{1,64})\/redeliver$/);
      if (req.method === "POST" && redeliver) {
        const inv = invoices.get(redeliver[1]);
        if (!inv) return json(req, res, 404, { error: "not found" });
        if (!inv.webhook) return json(req, res, 409, { error: `invoice ${inv.id} has no webhook to redeliver` });
        // Bounded: resetting attempts to zero on demand let one authenticated
        // caller aim an unlimited stream of signed deliveries at the endpoint.
        inv.webhook.redeliveries = (inv.webhook.redeliveries ?? 0) + 1;
        if (inv.webhook.redeliveries > WEBHOOK_MAX_REDELIVERIES) {
          return json(req, res, 429, {
            error: `invoice ${inv.id} has been redelivered ${WEBHOOK_MAX_REDELIVERIES} times; fix the endpoint rather than retrying`,
          });
        }
        inv.webhook.attempts = 0;
        inv.webhook.nextAttemptAt = Date.now();
        delete inv.webhook.deliveredAt;
        invoices.set(inv.id, inv);
        await persist();
        void drainWebhooks();
        return json(req, res, 202, { queued: inv.id, deliveryId: inv.webhook.deliveryId });
      }
      const match = url.pathname.match(/^\/invoices\/([\w.-]+)$/);
      if (req.method === "GET" && match) {
        const inv = invoices.get(match[1]);
        return inv ? json(req, res, 200, inv) : json(req, res, 404, { error: "not found" });
      }
      // Recovery. A crash mid-create, or a row from an older build, otherwise
      // locks its id AND its address forever with no way back but hand-editing
      // the store. Settled invoices stay: deleting one would let its address be
      // reused and a late payment settle the successor.
      if (req.method === "DELETE" && match) {
        const inv = invoices.get(match[1]);
        if (!inv) return json(req, res, 404, { error: "not found" });
        if (!DELETABLE_STATES.has(inv.status)) {
          return json(req, res, 409, {
            error: `invoice ${inv.id} is ${inv.status}; only reserving, expired or needs_reregistration rows can be deleted`,
          });
        }
        invoices.delete(inv.id);
        await persist();
        log(`deleted ${inv.id} (was ${inv.status})`);
        return json(req, res, 200, { deleted: inv.id, was: inv.status });
      }
      return json(req, res, 404, { error: "unknown route" });
    } catch (err) {
      return json(req, res, 400, { error: err.message });
    }
  });
}

export {
  createInvoice,
  pollOnce,
  invoices,
  deliverWebhook,
  drainWebhooks,
  queueWebhook,
  invoicesCsv,
  restore,
  // Exported for tests: the guard that stops a failed create deleting whatever
  // legitimately holds its id is worth asserting directly.
  releaseReservation as releaseReservationForTest,
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (isMain) {
  await restore();
  makeServer().listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT}, rpc=${RPC_URL}, poll=${POLL_MS}ms`));
  setInterval(pollLoop, POLL_MS);
  void pollLoop();
}
