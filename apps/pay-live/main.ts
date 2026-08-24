// Hosted invoice page, real wallet edition. Two modes in one page:
//
//   /apps/pay-live/            → merchant tool: create a shareable invoice link
//   /apps/pay-live/?to=0x…&amount=2&memo=…  → payer view: the checkout itself
//
// Confirmation is done right here in the browser: poll the invoice address's
// balance over public RPC and confirm on the DELTA (baseline captured before
// payment), so a pre-funded address can never false-confirm. The server-side
// watcher does the same job headlessly for real merchants.
import { RpcProvider } from "starknet";
import { mountCheckout } from "../../packages/strk20-pay/src/ui.js";
import { EXPLORER_BASE, WalletApiAdapter } from "../../packages/strk20-pay/src/wallet/walletapi.js";
import { TOKENS, amountToUnits, resolveToken } from "../../packages/strk20-pay/src/tokens.js";
import { encodeQr, qrDataUri } from "../../packages/strk20-pay/src/qr.js";
import type { Invoice } from "../../packages/strk20-pay/src/types.js";

const RPC_URL = "https://rpc.starknet.lava.build";
const app = document.getElementById("app")!;

const params = new URLSearchParams(location.search);
const to = params.get("to");

/**
 * A merchant server this page is willing to treat as an authority.
 *
 * Set it when you host this page yourself. Left empty, the page falls back to
 * its own origin, so a merchant who serves both from one host needs no
 * configuration at all.
 */
const TRUSTED_WATCHER = "";

/**
 * The merchant's watcher, if there is one we are allowed to believe.
 *
 * The `watcher` query parameter is NOT it. The whole point of asking a server
 * for the amount is that the payer controls this URL, and a payer who can edit
 * `amount` can edit `watcher` just as easily. Worse: honouring a link-supplied
 * origin turned the page's honest warning ("this amount came from the link,
 * the receipt is not proof") into a green "the merchant's server confirmed
 * these terms" badge, issued to whatever host the link named. A phishing link
 * could vouch for its own address and its own price.
 *
 * So the authority is decided by whoever DEPLOYED this page: a build-time
 * constant, or the page's own origin. A `watcher` parameter pointing anywhere
 * else is ignored, and the page says plainly that the amount came from the
 * link.
 */
function watcherOrigin(): string | null {
  const candidate = TRUSTED_WATCHER || location.origin;
  try {
    const url = new URL(candidate);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Did this link ask us to trust a server we are not deploying alongside? */
function linkNamedAForeignWatcher(): string | null {
  const raw = params.get("watcher");
  if (!raw) return null;
  try {
    return new URL(raw).origin === watcherOrigin() ? null : new URL(raw).host;
  } catch {
    return raw.slice(0, 60);
  }
}

if (!to) {
  renderCreator();
} else if (!/^0x[0-9a-fA-F]{10,64}$/.test(to)) {
  // A malformed address would send an unshield into the void. Refuse loudly.
  renderError("This invoice link has an invalid receive address, so it cannot be paid safely.");
} else if ((params.get("amount") ?? "").trim() === "") {
  // A STATIC counter code: one printed QR that every customer scans, with the
  // amount chosen at the till. It used to fall through to a hardcoded default
  // of 2 STRK, so a link that named no price quietly charged one.
  renderCounter(to);
} else {
  const amount = params.get("amount")!.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) {
    renderError("This invoice link has an invalid amount.");
  } else {
    void start({
      // A STABLE id, derived from the link's own terms when none is given.
      // Minting `inv_${Date.now()}` per page load meant the double-send guard,
      // which is keyed by invoice id, never matched its own record: a payer
      // whose confirmation timed out reloaded and paid a second time, while
      // the widget told them "it was sent once and will not be sent again".
      id: (params.get("id") || linkId(to, amount, params.get("memo") ?? "")).slice(0, 64),
      // Only STRK is served here: the widget resolves a token by symbol, and
      // paying a `?token=ETH` link in STRK would send the wrong asset. This
      // used to be a ternary with the same value on both sides.
      token: "STRK",
      amount,
      memo: params.get("memo")?.slice(0, 140) || undefined,
      mode: "address",
      receiveAddress: to,
      network: "mainnet",
      createdAt: Date.now(),
    });
  }
}

/**
 * A deterministic id for a link that carries none: same link, same id, every
 * load and every tab. Not a hash for secrecy, just for stability.
 */
function linkId(to: string, amount: string, memo: string): string {
  const input = `${to.toLowerCase()}|${amount}|${memo}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `lnk_${h1.toString(36)}${h2.toString(36)}`;
}

/** Terms as the merchant's server states them. */
interface ServerInvoice {
  id: string;
  token: string;
  amount: string;
  receiveAddress: string;
  status: string;
  expiresAt: number | null;
  txHash: string | null;
}

/**
 * What the merchant's server said about this invoice.
 *
 * `unknown` means it answered and does not have it: the link was not issued by
 * that server, and paying it is unsafe. `unreachable` means we learned
 * nothing - a 500, a timeout, a blocked request - and the only honest response
 * to that is "try again", never an accusation.
 */
type Lookup =
  | { kind: "found"; invoice: ServerInvoice }
  | { kind: "unknown" }
  | { kind: "unreachable" };

/**
 * Is a watcher answering at this origin?
 *
 * Without this, a 404 was treated as "your server says it never issued this
 * invoice" - and a static host 404s everything. Served from GitHub Pages,
 * which is where this page is published, EVERY link was refused with an
 * accusation that the merchant had forged it.
 *
 * Probed on the payer route's own CORS terms, because /healthz used to send no
 * CORS headers at all and so was blocked in exactly the split-host deployment
 * the check exists for.
 */
async function watcherPresent(origin: string): Promise<boolean> {
  for (const path of ["/public/healthz", "/healthz"]) {
    try {
      const res = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (body?.ok === true) return true;
    } catch {
      /* try the next path, then give up */
    }
  }
  return false;
}

async function lookupInvoice(origin: string, invoice: Invoice): Promise<Lookup> {
  const url = `${origin}/public/invoices/${encodeURIComponent(invoice.id)}?to=${encodeURIComponent(invoice.receiveAddress!)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    // A network failure, a CORS refusal, a timeout. This is also what a page
    // served from somewhere with no watcher at all sees.
    return { kind: "unreachable" };
  }
  // A 404 is only evidence if a watcher is answering here. A static host 404s
  // every path it does not have, which is every path.
  if (res.status === 404) return (await watcherPresent(origin)) ? { kind: "unknown" } : { kind: "unreachable" };
  if (!res.ok) return { kind: "unreachable" };
  const parsed = await parseServerInvoice(res, invoice);
  if (parsed) return { kind: "found", invoice: parsed };
  // A 200 that is not an invoice is not the server denying one. A host with a
  // single-page-app rewrite answers 200 with HTML for every path, and treating
  // that as a denial refused every link with an accusation.
  return (await watcherPresent(origin)) ? { kind: "unknown" } : { kind: "unreachable" };
}

async function parseServerInvoice(res: Response, invoice: Invoice): Promise<ServerInvoice | null> {
  const body = (await res.json().catch(() => null)) as ServerInvoice | null;
  // Every field is checked before use. A response is data from a server, and
  // an unexpected type here reaches string methods and BigInt() further down:
  // `expiresAt: {"nope":1}` used to throw out of an un-awaited call and leave
  // a blank page.
  if (!body || typeof body !== "object") return null;
  if (typeof body.amount !== "string" || typeof body.receiveAddress !== "string") return null;
  if (typeof body.status !== "string") return null;
  if (body.token !== undefined && typeof body.token !== "string") return null;
  if (body.expiresAt !== null && body.expiresAt !== undefined && typeof body.expiresAt !== "number") return null;
  // A server that answers about some other address, or some other token, is
  // not talking about this invoice, whatever it claims.
  try {
    if (BigInt(body.receiveAddress) !== BigInt(invoice.receiveAddress!)) return null;
  } catch {
    return null;
  }
  if (body.token !== undefined && body.token !== invoice.token) return null;
  if (!/^\d+(\.\d{1,18})?$/.test(body.amount) || Number(body.amount) <= 0) return null;
  return body;
}

/**
 * Resolve who decides what this invoice costs, then render. Without a watcher
 * the page still works, but it says plainly that its receipt is a payer-side
 * observation and not the merchant's confirmation.
 */
async function start(fromUrl: Invoice): Promise<void> {
  const foreign = linkNamedAForeignWatcher();
  const origin = watcherOrigin();
  if (!origin) return renderPayer(fromUrl, null, foreign);

  const lookup = await lookupInvoice(origin, fromUrl);
  const host = new URL(origin).host;

  // The lookup's own status code decides this, not a second probe. Asking
  // /healthz instead meant the refusal was silently OFF in every split-host
  // deployment - /healthz sends no CORS headers while /public sends `*`, so
  // the probe was blocked exactly where it mattered - and wrongly ON when the
  // server erred, telling a legitimate payer their link was forged.
  if (lookup.kind === "unknown") {
    return renderError(
      `The merchant's server at ${host} does not recognise this invoice. Do not pay it: the amount and the ` +
        "destination in this link are not ones that server issued. Ask the merchant for a fresh link.",
    );
  }
  if (lookup.kind === "unreachable") {
    // Either there is no watcher here at all (the hosted copy) or it is having
    // a bad minute. Neither is the payer's fault and neither is evidence.
    return renderPayer(fromUrl, null, foreign);
  }
  const server = lookup.invoice;
  if (server.status !== "watching") {
    return renderError(
      server.status === "paid" || server.status === "paid_late"
        ? "This invoice has already been paid. Nothing more is owed, so this page will not take another payment."
        : `The merchant's server is no longer accepting payment for this invoice (${server.status.replace(/_/g, " ")}). Ask for a fresh link.`,
    );
  }
  // The server's number wins. The URL's was only ever a hint.
  renderPayer(
    { ...fromUrl, amount: server.amount, expiresAt: server.expiresAt ?? undefined },
    { origin, server, urlAmount: fromUrl.amount },
    foreign,
  );
}

interface Authority {
  origin: string;
  server: ServerInvoice;
  urlAmount: string;
}

/**
 * A QR on a white card, whatever the page's theme.
 *
 * Two rules a payment QR has to obey and that are easy to get wrong: dark
 * modules on a light field (an inverted code fails on many readers), and the
 * four-module quiet zone, which `qrSvg` refuses to drop.
 */
function qrCard(text: string, caption: string, scale = 6): HTMLElement {
  const card = document.createElement("div");
  card.className = "qr";
  const img = document.createElement("img");
  img.src = qrDataUri(encodeQr(text), { scale, label: caption });
  img.alt = caption;
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = caption;
  card.append(img, cap);
  return card;
}

/** Print just the counter card, without the rest of the page around it. */
function printCard(title: string, text: string, lines: string[]): void {
  const area = document.getElementById("print-area")!;
  area.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = title;
  area.append(h, qrCard(text, "", 10));
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    area.append(p);
  }
  window.print();
}

/**
 * The payer half of a static counter code: the destination is fixed and
 * printed, the amount is not.
 *
 * Reusing one address is the whole point of a counter code and also its cost,
 * and a privacy checkout that stayed quiet about that would be selling the
 * wrong thing. Every payment lands on the same public address, so anyone
 * reading the chain can add up a shop's takings and count its customers. The
 * payer's side stays private either way: the pool severs who sent it.
 */
function renderCounter(destination: string): void {
  app.replaceChildren();
  const title = document.createElement("h1");
  title.textContent = "How much are you paying?";
  const memo = document.createElement("p");
  memo.className = "muted";
  memo.textContent =
    params.get("memo")?.slice(0, 140) || "This counter code does not carry a price, so enter one.";

  const label = document.createElement("label");
  label.textContent = "Amount (STRK)";
  const input = document.createElement("input");
  input.id = "c-amount";
  input.inputMode = "decimal";
  input.placeholder = "2";
  input.autofocus = true;
  label.append(input);

  const problem = document.createElement("p");
  problem.className = "check bad";
  problem.hidden = true;

  const go = document.createElement("button");
  go.textContent = "Continue";

  const where = document.createElement("p");
  where.className = "muted small";
  where.textContent = `Paying to ${destination.slice(0, 10)}…${destination.slice(-6)}.`;

  const note = document.createElement("p");
  note.className = "check";
  note.textContent =
    "This is a reusable counter code, so every payment made with it arrives at that one address. " +
    "Anyone reading the chain can therefore add up what this address has taken. Who paid stays " +
    "private: the pool severs that. For an invoice that should not be countable alongside the " +
    "others, ask the merchant for a one-time link instead.";

  const submit = () => {
    const value = input.value.trim();
    if (!/^\d+(\.\d{1,18})?$/.test(value) || Number(value) <= 0) {
      problem.hidden = false;
      problem.textContent = "Enter an amount greater than zero, with at most 18 decimal places.";
      input.focus();
      return;
    }
    // Back through the same URL, so the ordinary payer flow handles it and the
    // link stays shareable and correct in the back button.
    const url = new URL(location.href);
    url.searchParams.set("amount", value);
    location.href = url.toString();
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });

  app.append(title, memo, label, problem, go, where, note);
}

function renderError(message: string): void {
  app.replaceChildren();
  const h = document.createElement("h1");
  h.textContent = "Invalid invoice link";
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = message;
  app.append(h, p);
}

function renderCreator(): void {
  // Two shapes of code, which is the distinction IDEA-11 draws:
  //   dynamic - one link and one QR per invoice, with the price baked in
  //   static  - one code printed once, the price entered at the till
  app.innerHTML = `
    <h1>Create a payment link</h1>
    <p class="muted">Share the link, or show the QR. The payer pays privately; you watch the
    address (or run <code>server/watcher</code> for webhooks).</p>
    <label>What kind of code?
      <select id="f-kind">
        <option value="dynamic">One-time invoice: fixed price, fresh address</option>
        <option value="static">Counter code: printed once, price entered by the payer</option>
      </select>
    </label>
    <label>Receive address<input id="f-to" placeholder="0x…" /></label>
    <label id="f-amount-row">Amount (STRK)<input id="f-amount" value="2" /></label>
    <label>Memo (never goes on-chain)<input id="f-memo" placeholder="Order #42" /></label>
    <label id="f-id-row">Invoice id, as registered with your watcher (optional)<input id="f-id" placeholder="inv_9f2a" /></label>
    <p class="muted small" id="f-advice"></p>
    <button id="f-make">Create link</button>
    <div id="f-out" class="out" hidden></div>
  `;

  const kind = document.getElementById("f-kind") as HTMLSelectElement;
  const amountRow = document.getElementById("f-amount-row")!;
  const idRow = document.getElementById("f-id-row")!;
  const advice = document.getElementById("f-advice")!;
  const out = document.getElementById("f-out")!;

  const DYNAMIC_ADVICE =
    "The amount and the destination live in this link. A payer who edits it pays the edited amount and " +
    "still sees a receipt, so treat that receipt as an observation and never as proof. To have the terms " +
    "come from your server instead, serve this page from the same origin as your watcher: a link cannot " +
    "nominate its own auditor, so there is deliberately no field for one here. Use a FRESH address per invoice.";
  const STATIC_ADVICE =
    "A counter code names no price, so the payer enters one. It is the same address every time, which is " +
    "what makes it printable and also what it costs you: anyone reading the chain can add up what this " +
    "address has taken and count how many payments made it up. Your payers stay private either way, since " +
    "the pool severs who sent each one. Use a counter code for tips and small trade, and a one-time link " +
    "for anything whose size you would rather not publish.";

  const sync = () => {
    const isStatic = kind.value === "static";
    amountRow.hidden = isStatic;
    idRow.hidden = isStatic;
    advice.textContent = isStatic ? STATIC_ADVICE : DYNAMIC_ADVICE;
    out.hidden = true;
  };
  kind.addEventListener("change", sync);
  sync();

  document.getElementById("f-make")!.addEventListener("click", () => {
    const isStatic = kind.value === "static";
    const toValue = (document.getElementById("f-to") as HTMLInputElement).value.trim();
    const amount = (document.getElementById("f-amount") as HTMLInputElement).value.trim();
    const memo = (document.getElementById("f-memo") as HTMLInputElement).value.trim();
    const invoiceId = (document.getElementById("f-id") as HTMLInputElement).value.trim();

    out.hidden = false;
    out.replaceChildren();
    if (!/^0x[0-9a-fA-F]{10,64}$/.test(toValue)) {
      out.textContent = "Enter a valid Starknet address.";
      return;
    }
    if (!isStatic && (!/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) <= 0)) {
      out.textContent = "Enter an amount greater than zero, with at most 18 decimal places.";
      return;
    }

    const url = new URL(location.href);
    url.search = new URLSearchParams({
      to: toValue,
      // A static code carries no amount at all. Sending an empty one would make
      // the link look priced and read as unpriced.
      ...(isStatic ? {} : { amount }),
      ...(memo ? { memo } : {}),
      ...(!isStatic && invoiceId ? { id: invoiceId } : {}),
    }).toString();
    const href = url.toString();

    const link = document.createElement("a");
    link.href = href;
    link.textContent = href;

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      qrCard(
        href,
        isStatic ? "Scan to pay at this counter" : `Scan to pay ${amount} STRK`,
        isStatic ? 7 : 6,
      ),
    );

    const buttons = document.createElement("div");
    const copy = document.createElement("button");
    copy.textContent = "Copy link";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(href);
      copy.textContent = "Copied ✓";
    });
    buttons.append(copy);

    if (isStatic) {
      const print = document.createElement("button");
      print.textContent = "Print card";
      print.addEventListener("click", () =>
        printCard(memo || "Pay privately", href, [
          "Scan with a Starknet wallet that supports STRK20 private payments.",
          `To: ${toValue}`,
          "You choose the amount. The pool charges a flat 6 STRK per payment.",
        ]),
      );
      buttons.append(print);
    }
    row.append(buttons);
    out.append(link, row);
  });
}

/**
 * Wallet compatibility panel. Privacy actions need a wallet advertising Wallet
 * API >= 0.10.3 (Ready X, Xverse). The older Ready extension connects fine but
 * cannot pay privately, so say which wallets were found and whether each is
 * capable, instead of failing later with a vague error.
 */
async function reportWalletSupport(wallet: WalletApiAdapter): Promise<void> {
  const box = document.getElementById("wallet-check")!;
  box.textContent = "Checking your wallet…";
  try {
    const found = await wallet.listWallets();
    if (found.length === 0) {
      box.className = "check bad";
      box.textContent =
        "No Starknet wallet detected in this browser. Install Ready X from the Chrome Web Store, then reload.";
      return;
    }
    const capable = found.filter((w) => w.strk20);
    const names = found.map((w) => `${w.name}${w.strk20 ? " (private payments: yes)" : " (private payments: no)"}`);
    if (capable.length > 0) {
      box.className = "check good";
      box.textContent = `Ready to pay privately. Detected: ${names.join(", ")}`;
    } else {
      box.className = "check bad";
      box.textContent =
        `Detected ${names.join(", ")}. None of these can make private payments yet. ` +
        "If yours still shows the old name \"Ready Wallet (Formerly Argent)\", it is out of date: the same extension is now called Ready X. " +
        "Update it (browser extensions page, turn on Developer mode, press Update), enable Smart Wallet + Private, then reload this page.";
    }
  } catch (err) {
    box.className = "check bad";
    box.textContent = `Could not check your wallet: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function renderPayer(
  invoice: Invoice,
  authority: Authority | null,
  foreignWatcher: string | null = null,
): Promise<void> {
  // Built node by node with textContent. These values come from the URL, and
  // interpolating them into innerHTML would let any link run script on this
  // origin and rewrite the address being paid.
  app.replaceChildren();
  const title = document.createElement("h1");
  title.textContent = `Invoice ${invoice.id}`;
  const memo = document.createElement("p");
  memo.className = "muted";
  memo.textContent = invoice.memo ?? "Private payment on Starknet mainnet";
  const check = document.createElement("div");
  check.id = "wallet-check";
  check.className = "check";
  const host = document.createElement("div");
  host.id = "checkout";
  // Where the terms came from. A payer deserves to know whether the number
  // above is the merchant's or merely this link's.
  const source = document.createElement("p");
  source.className = "check";
  if (authority) {
    source.classList.add("good");
    source.textContent = `Terms confirmed by the merchant's server at ${new URL(authority.origin).host}, which serves this page.`;
    if (authority.urlAmount !== invoice.amount) {
      source.textContent += ` This link said ${authority.urlAmount} ${invoice.token}; the server says ${invoice.amount} ${invoice.token}, and the server is what counts.`;
    }
  } else {
    source.classList.add("bad");
    source.textContent =
      "The amount and the destination above come from this link, and nothing here has checked them. " +
      "Confirm both with the merchant through a channel you already trust before paying. " +
      "This page can show you that the money arrived; its receipt is not proof of payment to anyone else.";
    if (foreignWatcher) {
      // Named and neutralised, rather than silently dropped: a payer who was
      // told to expect a watcher deserves to know it was ignored.
      source.textContent +=
        ` This link asked to be verified by ${foreignWatcher}, which is not the server hosting this page. ` +
        "That request was ignored: a link cannot nominate its own auditor.";
    }
  }

  const foot = document.createElement("p");
  foot.className = "muted small";
  foot.textContent = authority
    ? "Settlement is confirmed by the merchant's watcher, cross-checked here against public RPC. Payer identity is severed by the STRK20 pool. "
    : "Confirmation runs in this page over public RPC (balance delta on the invoice address). Payer identity is severed by the STRK20 pool. ";
  // Built from the network this page is actually on, not hardcoded to mainnet
  // Voyager. Note that a counterfactual (undeployed) receive address, which is
  // the recommended setup, has no contract page: the link is to look up
  // transfers, not to prove the account exists.
  const explorer = EXPLORER_BASE[invoice.network];
  const link = document.createElement("a");
  link.href = `${explorer}/contract/${encodeURIComponent(invoice.receiveAddress!)}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "look up this address";
  foot.append(link);
  // Wallets that can do STRK20 are browser extensions on the desktop and apps
  // on a phone. A payer who opened this on the wrong one should not have to
  // retype a link this long.
  const hop = document.createElement("details");
  const hopTitle = document.createElement("summary");
  hopTitle.textContent = "Pay from your phone instead";
  hopTitle.className = "muted";
  const hopBody = document.createElement("div");
  hopBody.style.marginTop = "10px";
  hopBody.append(qrCard(location.href, "This same invoice, on your phone"));
  hop.append(hopTitle, hopBody);

  app.append(title, memo, source, check, host, hop, foot);

  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const token = resolveToken(invoice.token, TOKENS);
  const readBalance = async (): Promise<bigint> => {
    const res = await provider.callContract({
      contractAddress: token.address,
      entrypoint: "balanceOf",
      calldata: [invoice.receiveAddress!],
    });
    return BigInt(res[0] ?? "0x0") + (BigInt(res[1] ?? "0x0") << 128n);
  };

  // The baseline is the whole safety property. Retry rather than fall back to
  // an absolute check: an address that already holds funds would confirm
  // instantly and the payer would be told "paid" without paying.
  //
  // And it must survive a reload. Re-reading it on every page load meant that
  // after paying and reloading, the payer's OWN money was inside the baseline:
  // the delta was zero forever, the widget correctly refused to pay twice, and
  // then told them for ten minutes at a time that the payment it could see on
  // chain had not been confirmed. It never self-healed.
  const baselineKey = `spay-baseline.${invoice.network}.${invoice.id}.${invoice.receiveAddress}`;
  const rememberedBaseline = (() => {
    try {
      const raw = localStorage.getItem(baselineKey);
      return raw && /^\d+$/.test(raw) ? BigInt(raw) : null;
    } catch {
      return null;
    }
  })();

  let baseline: bigint | null = rememberedBaseline;
  for (let attempt = 0; attempt < 5 && baseline === null; attempt++) {
    try {
      baseline = await readBalance();
      try {
        localStorage.setItem(baselineKey, baseline.toString());
      } catch {
        /* a payer with storage disabled just gets the old behaviour */
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  if (baseline === null) {
    const box = document.getElementById("wallet-check")!;
    box.className = "check bad";
    box.textContent =
      "Could not read this invoice address from the network, so a payment cannot be confirmed here. Reload in a moment.";
    return;
  }

  const wallet = new WalletApiAdapter({ network: "mainnet", rpcUrl: RPC_URL });
  void reportWalletSupport(wallet);
  mountCheckout(document.getElementById("checkout")!, {
    invoice,
    wallet,
    async confirm() {
      const target = amountToUnits(invoice.amount, token.decimals);
      const started = Date.now();
      while (Date.now() - started < 10 * 60_000) {
        // The merchant's server is the one whose answer ships the order, so
        // ask it first. Its baseline was captured when the invoice was
        // registered, which is strictly better than this page's, captured
        // whenever the payer happened to open the link.
        if (authority) {
          try {
            const fresh = await lookupInvoice(authority.origin, invoice);
            if (fresh.kind === "found" && (fresh.invoice.status === "paid" || fresh.invoice.status === "paid_late")) {
              return true;
            }
          } catch {
            /* fall through to the chain */
          }
        }
        try {
          const received = (await readBalance()) - baseline;
          if (received >= target) return true;
        } catch {
          /* RPC refusal is not a chain answer: keep polling */
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
      return false;
    },
  });
}
