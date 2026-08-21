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

if (!to) {
  renderCreator();
} else {
  void renderPayer({
    id: params.get("id") ?? `inv_${Date.now().toString(36)}`,
    token: params.get("token") ?? "STRK",
    amount: params.get("amount") ?? "2",
    memo: params.get("memo") ?? undefined,
    mode: "address",
    receiveAddress: to,
    network: "mainnet",
    createdAt: Date.now(),
  });
}

function renderCreator(): void {
  app.innerHTML = `
    <h1>Create an invoice link</h1>
    <p class="muted">Fill this in and share the link. The payer pays privately; you watch the
    address (or run <code>server/watcher</code> for webhooks). Use a FRESH address per invoice.</p>
    <label>Receive address (fresh, one per invoice)<input id="f-to" placeholder="0x…" /></label>
    <label>Amount (STRK)<input id="f-amount" value="2" /></label>
    <label>Memo (never goes on-chain)<input id="f-memo" placeholder="Order #42" /></label>
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
    const url = new URL(location.href);
    url.search = new URLSearchParams({ to: toValue, amount, ...(memo ? { memo } : {}) }).toString();
    out.hidden = false;
    out.innerHTML = "";
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

async function renderPayer(invoice: Invoice): Promise<void> {
  app.innerHTML = `
    <h1>Invoice ${invoice.id}</h1>
    <p class="muted">${invoice.memo ?? "Private payment on Starknet mainnet"}</p>
    <div id="wallet-check" class="check"></div>
    <div id="checkout"></div>
    <p class="muted small">Confirmation runs in this page over public RPC (balance delta on the
    invoice address). Payer identity is severed by the STRK20 pool.
    <a href="https://voyager.online/contract/${invoice.receiveAddress}" target="_blank" rel="noreferrer">address on Voyager ↗</a></p>
  `;

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

  let baseline: bigint | null = null;
  try {
    baseline = await readBalance();
  } catch {
    baseline = null; // RPC hiccup at load: fall back to absolute check at confirm time
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
        try {
          const now = await readBalance();
          const delta = baseline === null ? now : now - baseline;
          if (delta >= target) return true;
        } catch {
          /* RPC refusal is not a chain answer: keep polling */
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
      return false;
    },
  });
}
