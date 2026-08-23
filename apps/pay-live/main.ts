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
import { WalletApiAdapter } from "../../packages/strk20-pay/src/wallet/walletapi.js";
import { TOKENS, amountToUnits, resolveToken } from "../../packages/strk20-pay/src/tokens.js";
import type { Invoice } from "../../packages/strk20-pay/src/types.js";

const RPC_URL = "https://rpc.starknet.lava.build";
const app = document.getElementById("app")!;

const params = new URLSearchParams(location.search);
const to = params.get("to");

/**
 * The merchant's watcher, if the link names one. Everything in this page's
 * query string is under the payer's control, including the amount, so a link
 * edited to `amount=0.001` used to produce a real "Paid" screen for a
 * thousandth of the price. When a watcher is named, the invoice's terms and
 * its settlement both come from there instead, and this page is only a view.
 */
function watcherOrigin(): string | null {
  const raw = params.get("watcher");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

if (!to) {
  renderCreator();
} else if (!/^0x[0-9a-fA-F]{10,64}$/.test(to)) {
  // A malformed address would send an unshield into the void. Refuse loudly.
  renderError("This invoice link has an invalid receive address, so it cannot be paid safely.");
} else {
  const amount = params.get("amount") ?? "2";
  if (!/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) {
    renderError("This invoice link has an invalid amount.");
  } else {
    void start({
      id: (params.get("id") ?? `inv_${Date.now().toString(36)}`).slice(0, 64),
      token: params.get("token") === "STRK" ? "STRK" : "STRK",
      amount,
      memo: params.get("memo")?.slice(0, 140) || undefined,
      mode: "address",
      receiveAddress: to,
      network: "mainnet",
      createdAt: Date.now(),
    });
  }
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

async function fetchServerInvoice(origin: string, invoice: Invoice): Promise<ServerInvoice | null> {
  const url = `${origin}/public/invoices/${encodeURIComponent(invoice.id)}?to=${encodeURIComponent(invoice.receiveAddress!)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const body = (await res.json()) as ServerInvoice;
  // A server that answers about some other address is not talking about this
  // invoice, whatever it claims.
  if (!body || typeof body.amount !== "string") return null;
  if (BigInt(body.receiveAddress) !== BigInt(invoice.receiveAddress!)) return null;
  if (!/^\d+(\.\d{1,18})?$/.test(body.amount) || Number(body.amount) <= 0) return null;
  return body;
}

/**
 * Resolve who decides what this invoice costs, then render. Without a watcher
 * the page still works, but it says plainly that its receipt is a payer-side
 * observation and not the merchant's confirmation.
 */
async function start(fromUrl: Invoice): Promise<void> {
  const origin = watcherOrigin();
  if (!origin) return renderPayer(fromUrl, null);
  let server: ServerInvoice | null = null;
  let reachable = true;
  try {
    server = await fetchServerInvoice(origin, fromUrl);
  } catch {
    // A network failure and a rejection mean different things to the payer:
    // one is "wait and reload", the other is "this link is not real".
    reachable = false;
    server = null;
  }
  if (!server) {
    const host = new URL(origin).host;
    return renderError(
      reachable
        ? `The merchant's server at ${host} does not recognise this invoice. Do not pay it: ask the merchant for a fresh link.`
        : `The merchant's server at ${host} could not be reached, so the amount on this link cannot be verified. ` +
          "Reload in a moment. Paying an unverified link risks paying the wrong amount.",
    );
  }
  if (server.status !== "watching") {
    return renderError(
      server.status === "paid" || server.status === "paid_late"
        ? "This invoice has already been paid. Nothing more is owed, so this page will not take another payment."
        : `The merchant's server is no longer accepting payment for this invoice (${server.status.replace(/_/g, " ")}). Ask for a fresh link.`,
    );
  }
  // The server's number wins. The URL's was only ever a hint.
  renderPayer({ ...fromUrl, amount: server.amount, expiresAt: server.expiresAt ?? undefined }, { origin, server, urlAmount: fromUrl.amount });
}

interface Authority {
  origin: string;
  server: ServerInvoice;
  urlAmount: string;
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
  app.innerHTML = `
    <h1>Create an invoice link</h1>
    <p class="muted">Fill this in and share the link. The payer pays privately; you watch the
    address (or run <code>server/watcher</code> for webhooks). Use a FRESH address per invoice.</p>
    <label>Receive address (fresh, one per invoice)<input id="f-to" placeholder="0x…" /></label>
    <label>Amount (STRK)<input id="f-amount" value="2" /></label>
    <label>Memo (never goes on-chain)<input id="f-memo" placeholder="Order #42" /></label>
    <label>Invoice id, as registered with your watcher (optional)<input id="f-id" placeholder="inv_9f2a" /></label>
    <label>Watcher URL (optional, strongly recommended)<input id="f-watcher" placeholder="https://pay.example.com" /></label>
    <p class="muted small">With a watcher, the payer's page reads the amount from your server and settles
    against it. Without one, the amount lives in the link, and a payer who edits the link pays the edited
    amount and still sees a receipt: treat that receipt as an observation, never as proof.</p>
    <button id="f-make">Create link</button>
    <div id="f-out" class="out" hidden></div>
  `;
  document.getElementById("f-make")!.addEventListener("click", () => {
    const toValue = (document.getElementById("f-to") as HTMLInputElement).value.trim();
    const amount = (document.getElementById("f-amount") as HTMLInputElement).value.trim();
    const memo = (document.getElementById("f-memo") as HTMLInputElement).value.trim();
    const out = document.getElementById("f-out")!;
    if (!/^0x[0-9a-fA-F]{10,}$/.test(toValue)) {
      out.hidden = false;
      out.textContent = "Enter a valid Starknet address.";
      return;
    }
    const watcher = (document.getElementById("f-watcher") as HTMLInputElement).value.trim();
    const invoiceId = (document.getElementById("f-id") as HTMLInputElement).value.trim();
    if (watcher && !invoiceId) {
      out.hidden = false;
      out.textContent = "A watcher URL needs the invoice id it was registered under.";
      return;
    }
    const url = new URL(location.href);
    url.search = new URLSearchParams({
      to: toValue,
      amount,
      ...(memo ? { memo } : {}),
      ...(invoiceId ? { id: invoiceId } : {}),
      ...(watcher ? { watcher } : {}),
    }).toString();
    out.hidden = false;
    out.replaceChildren();
    const link = document.createElement("a");
    link.href = url.toString();
    link.textContent = url.toString();
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(url.toString());
      copy.textContent = "Copied ✓";
    });
    out.append(link, copy);
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

async function renderPayer(invoice: Invoice, authority: Authority | null): Promise<void> {
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
    source.textContent = `Terms confirmed by the merchant's server at ${new URL(authority.origin).host}.`;
    if (authority.urlAmount !== invoice.amount) {
      source.textContent += ` This link said ${authority.urlAmount} ${invoice.token}; the server says ${invoice.amount} ${invoice.token}, and the server is what counts.`;
    }
  } else {
    source.textContent =
      "The amount above comes from this link, not from a merchant server. This page can show you that " +
      "the money arrived, but its receipt is not proof of payment to anyone else: the merchant confirms " +
      "independently from the chain.";
  }

  const foot = document.createElement("p");
  foot.className = "muted small";
  foot.textContent = authority
    ? "Settlement is confirmed by the merchant's watcher, cross-checked here against public RPC. Payer identity is severed by the STRK20 pool. "
    : "Confirmation runs in this page over public RPC (balance delta on the invoice address). Payer identity is severed by the STRK20 pool. ";
  const link = document.createElement("a");
  link.href = `https://voyager.online/contract/${encodeURIComponent(invoice.receiveAddress!)}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "address on Voyager";
  foot.append(link);
  app.append(title, memo, source, check, host, foot);

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
  let baseline: bigint | null = null;
  for (let attempt = 0; attempt < 5 && baseline === null; attempt++) {
    try {
      baseline = await readBalance();
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
            const fresh = await fetchServerInvoice(authority.origin, invoice);
            if (fresh && (fresh.status === "paid" || fresh.status === "paid_late")) return true;
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
