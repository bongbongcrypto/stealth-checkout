import { StealthCheckout, addAmounts, compareAmounts } from "./checkout.js";
import { TOKENS, resolveToken } from "./tokens.js";
/**
 * The drop-in widget. One call renders a complete checkout into `container`:
 * pay button, live progress line (always next to the button), the pre-sign
 * honesty panel, and the receipt. No framework, no external CSS.
 */
export function mountCheckout(container, opts) {
    injectStylesOnce();
    const { invoice, wallet } = opts;
    const checkout = new StealthCheckout(wallet, opts.confirm, opts.allowInlineShield ?? false);
    const root = el("div", "spay");
    const amountLine = el("div", "spay-amount");
    amountLine.textContent = `${invoice.amount} ${invoice.token}`;
    if (invoice.memo) {
        const memo = el("div", "spay-memo");
        memo.textContent = invoice.memo;
        amountLine.append(memo);
    }
    // What the payer is actually agreeing to. The destination comes from a URL
    // in the hosted case, so it is the one value an attacker would swap, and
    // showing it before the wallet opens is the difference between trust and
    // hope. The pool's flat fee is real money the payer spends on top of the
    // invoice, and it appears nowhere in the protocol's own documentation.
    const confirmBox = document.createElement("dl");
    confirmBox.className = "spay-confirm";
    const recipient = invoice.receiveAddress ?? invoice.merchantPoolAddress ?? "";
    const confirmRow = (label, value) => {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        if (typeof value === "string")
            dd.textContent = value;
        else
            dd.append(value);
        confirmBox.append(dt, dd);
    };
    confirmRow("Merchant receives", `${invoice.amount} ${invoice.token}`);
    const feeCell = document.createElement("span");
    feeCell.textContent = "checking\u2026";
    confirmRow("Pool fee", feeCell);
    const totalCell = document.createElement("strong");
    totalCell.textContent = "\u2014";
    confirmRow("You pay", totalCell);
    if (recipient)
        confirmRow("To", explorerNode(wallet, "address", recipient));
    confirmRow("Network", invoice.network === "mainnet" ? "Starknet mainnet" : "Starknet sepolia");
    // The pool charges a flat fee per operation, so it is a rounding error on a
    // large invoice and the whole cost of a small one. A checkout that shows the
    // price and hides that is lying by omission, and at 6 STRK it is the single
    // most important number on the screen for anyone pricing goods in STRK.
    const feeWarning = el("div", "spay-fee-warn");
    feeWarning.hidden = true;
    const decimals = (() => {
        try {
            return resolveToken(invoice.token, TOKENS).decimals;
        }
        catch {
            return 18;
        }
    })();
    void (async () => {
        const fee = (await wallet.poolFee?.(invoice.token)) ?? null;
        if (fee === null) {
            feeCell.textContent = "unknown";
            totalCell.textContent = `${invoice.amount} ${invoice.token} plus the pool fee`;
            return;
        }
        feeCell.textContent = `${fee} ${invoice.token}`;
        totalCell.textContent = `${addAmounts(invoice.amount, fee, decimals)} ${invoice.token}`;
        if (compareAmounts(fee, invoice.amount, decimals) > 0) {
            feeWarning.hidden = false;
            feeWarning.textContent =
                `Heads up: the pool's flat fee of ${fee} ${invoice.token} is larger than this invoice. ` +
                    `Private payments through the pool cost the same fee whatever the amount, so small ones carry most of it. ` +
                    `Shield once for several purchases rather than once per purchase.`;
        }
    })();
    const button = el("button", "spay-btn");
    button.type = "button";
    const defaultLabel = opts.label ?? `Pay ${invoice.amount} ${invoice.token} privately`;
    button.textContent = defaultLabel;
    const status = el("div", "spay-status");
    status.setAttribute("role", "status");
    const honesty = buildHonestyPanel();
    const receiptBox = el("div", "spay-receipt");
    receiptBox.hidden = true;
    // The honesty panel sits ABOVE the button and starts open: it exists to be
    // read before signing, and a collapsed footnote under the CTA was not.
    root.append(amountLine, confirmBox, feeWarning, honesty.root, button, status, receiptBox);
    container.append(root);
    void checkout.preview(invoice).then((rows) => honesty.render(rows));
    const off = checkout.on((event) => {
        // Recompute once connected: before that the panel assumes a shield leg is
        // needed, which is the safe guess but wrong for a funded payer, and being
        // inaccurate is its own kind of dishonesty.
        if (event.type === "progress" && event.progress.phase === "preparing") {
            void checkout.preview(invoice).then((rows) => honesty.render(rows));
        }
        if (event.type === "progress")
            renderProgress(event.progress);
        if (event.type === "paid")
            renderReceipt(event.receipt);
    });
    button.addEventListener("click", () => {
        button.disabled = true;
        checkout
            .pay(invoice)
            .catch((err) => {
            opts.onFailed?.(err instanceof Error ? err.message : String(err));
            button.disabled = false;
            button.textContent = `Retry: ${defaultLabel}`;
        });
    });
    function renderProgress(p) {
        status.setAttribute("aria-live", p.phase === "failed" ? "assertive" : "polite");
        status.textContent = p.message;
        status.classList.toggle("spay-status-popup", p.walletPopupImminent);
        status.classList.toggle("spay-status-error", p.phase === "failed");
        const labels = {
            connecting: "Connecting…",
            preparing: "Checking balance…",
            shielding: "Shielding…",
            maturing: "Waiting for notes to mature…",
            paying: "Paying…",
            confirming: "Confirming…",
            paid: "Paid ✓",
        };
        if (p.phase !== "failed")
            button.textContent = labels[p.phase] ?? defaultLabel;
    }
    function renderReceipt(receipt) {
        receiptBox.setAttribute("role", "status");
        receiptBox.tabIndex = -1;
        button.hidden = true;
        honesty.root.hidden = true;
        receiptBox.hidden = false;
        receiptBox.replaceChildren(line("spay-receipt-title", "Receipt"), line("spay-receipt-row", `Invoice ${receipt.invoiceId}`), line("spay-receipt-row", `${receipt.amount} ${receipt.token} · ${receipt.mode === "address" ? "invoice address" : "private note"} · ${receipt.network}`), txLine(wallet, "payment", receipt.txHash), txLine(wallet, "shield", receipt.shieldTxHash), line("spay-receipt-note", receipt.disclosure));
        receiptBox.focus(); // the button that had focus is gone
        opts.onPaid?.(receipt);
    }
    return {
        checkout,
        unmount() {
            off();
            root.remove();
        },
    };
}
function buildHonestyPanel() {
    const root = document.createElement("details");
    root.className = "spay-honesty";
    root.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "What will this payment reveal?";
    const list = el("div", "spay-honesty-list");
    root.append(summary, list);
    return {
        root,
        render(rows) {
            list.replaceChildren(...rows.map((row) => {
                const item = el("div", "spay-honesty-row");
                const badge = el("span", `spay-badge spay-badge-${row.visibility}`);
                badge.textContent = row.visibility === "public" ? "PUBLIC" : "HIDDEN";
                const body = el("div", "spay-honesty-body");
                const fact = el("div", "spay-honesty-fact");
                fact.textContent = row.fact;
                const detail = el("div", "spay-honesty-detail");
                detail.textContent = row.detail;
                body.append(fact, detail);
                item.append(badge, body);
                return item;
            }));
        },
    };
}
function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
}
/**
 * A shortened value, linked to an explorer only when the wallet names one. A
 * mock wallet's hashes exist nowhere, and a link to nowhere is worse than
 * plain text: it looks like proof and resolves to a 404.
 */
function explorerNode(wallet, kind, value) {
    const href = wallet.explorerUrl?.(kind, value) ?? null;
    if (!href) {
        const span = document.createElement("span");
        span.textContent = shorten(value);
        span.title = value;
        return span;
    }
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = shorten(value);
    a.title = value;
    return a;
}
/** A hash row that fits the card. */
function txLine(wallet, label, hash) {
    const row = el("div", "spay-receipt-row");
    if (!hash)
        return row;
    row.append(`${label} tx `, explorerNode(wallet, "tx", hash));
    return row;
}
function line(className, text) {
    const node = el("div", className);
    node.textContent = text;
    return node;
}
function shorten(hash) {
    return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}
let stylesInjected = false;
function injectStylesOnce() {
    if (stylesInjected || document.getElementById("spay-styles"))
        return;
    stylesInjected = true;
    const style = document.createElement("style");
    style.id = "spay-styles";
    style.textContent = `
.spay{--spay-bg:#111318;--spay-fg:#e8eaf0;--spay-accent:#7ee787;--spay-muted:#9aa1ad;--spay-danger:#ff7b72;
  background:var(--spay-bg);color:var(--spay-fg);border:1px solid #2a2e37;border-radius:12px;
  padding:16px;max-width:100%;width:340px;box-sizing:border-box;font:14px/1.45 system-ui,sans-serif}
.spay-amount{font-size:22px;font-weight:700;margin-bottom:2px}
.spay-memo{font-size:12px;font-weight:400;color:var(--spay-muted)}
.spay-btn{width:100%;margin-top:10px;padding:12px 14px;min-height:44px;border:0;border-radius:8px;cursor:pointer;
  background:var(--spay-accent);color:#08110a;font-weight:700;font-size:14px}
.spay-btn:disabled{opacity:.75;cursor:progress}
.spay-status{min-height:1.4em;margin-top:8px;font-size:12.5px;color:var(--spay-muted)}
.spay-status-popup{color:var(--spay-accent)}
.spay-status-popup::before{content:"↗ ";font-weight:700}
.spay-status-error{color:var(--spay-danger)}
.spay-honesty{margin-top:10px;border-top:1px solid #2a2e37;padding-top:8px;font-size:12.5px}
.spay-honesty summary{cursor:pointer;color:var(--spay-fg);font-weight:600;font-size:13px;padding:8px 0}
.spay-honesty-row{display:flex;gap:8px;margin-top:8px}
.spay-badge{flex:0 0 auto;height:fit-content;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700}
.spay-badge-public{background:#332f1c;color:#f0c674}
.spay-badge-hidden{background:#22321f;color:var(--spay-accent)}
.spay-honesty-fact{font-weight:600;font-size:13px;color:var(--spay-fg)}
.spay-honesty-detail{color:var(--spay-muted);font-size:12px;line-height:1.5;margin-top:2px}
.spay-receipt{margin-top:10px}
.spay-receipt-title{font-weight:700;color:var(--spay-accent)}
.spay-receipt-row{font-size:12.5px;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.spay-receipt-note{font-size:12px;color:var(--spay-muted);margin-top:8px;border-top:1px solid #2a2e37;padding-top:8px}
.spay-confirm{margin-top:10px;padding:10px;background:#0d0f14;border:1px solid #2a2e37;border-radius:8px;
  font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}
.spay-confirm dt{color:var(--spay-muted)}
.spay-confirm dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.spay-fee-warn{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;
  background:#332f1c;color:#f0c674;border:1px solid #5a5230}
.spay-btn:focus-visible{outline:3px solid #e8eaf0;outline-offset:2px}
.spay-honesty summary:focus-visible{outline:2px solid var(--spay-accent);outline-offset:2px;border-radius:4px}
.spay a:focus-visible{outline:2px solid var(--spay-accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.spay *{transition:none!important;animation:none!important}}
`;
    document.head.append(style);
}
