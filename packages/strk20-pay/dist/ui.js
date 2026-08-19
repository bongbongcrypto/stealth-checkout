import { StealthCheckout } from "./checkout.js";
/**
 * The drop-in widget. One call renders a complete checkout into `container`:
 * pay button, live progress line (always next to the button), the pre-sign
 * honesty panel, and the receipt. No framework, no external CSS.
 */
export function mountCheckout(container, opts) {
    injectStylesOnce();
    const { invoice, wallet } = opts;
    const checkout = new StealthCheckout(wallet, opts.confirm);
    const root = el("div", "spay");
    const amountLine = el("div", "spay-amount");
    amountLine.textContent = `${invoice.amount} ${invoice.token}`;
    if (invoice.memo) {
        const memo = el("div", "spay-memo");
        memo.textContent = invoice.memo;
        amountLine.append(memo);
    }
    const button = el("button", "spay-btn");
    button.type = "button";
    const defaultLabel = opts.label ?? `Pay ${invoice.amount} ${invoice.token} privately`;
    button.textContent = defaultLabel;
    const status = el("div", "spay-status");
    status.setAttribute("role", "status");
    const honesty = buildHonestyPanel();
    const receiptBox = el("div", "spay-receipt");
    receiptBox.hidden = true;
    root.append(amountLine, button, status, honesty.root, receiptBox);
    container.append(root);
    void checkout.preview(invoice).then((rows) => honesty.render(rows));
    const off = checkout.on((event) => {
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
            button.textContent = `Retry — ${defaultLabel}`;
        });
    });
    function renderProgress(p) {
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
        button.hidden = true;
        honesty.root.hidden = true;
        receiptBox.hidden = false;
        receiptBox.replaceChildren(line("spay-receipt-title", "Receipt"), line("spay-receipt-row", `Invoice ${receipt.invoiceId}`), line("spay-receipt-row", `${receipt.amount} ${receipt.token} · ${receipt.mode === "address" ? "invoice address" : "private note"} · ${receipt.network}`), line("spay-receipt-row", receipt.txHash ? `tx ${shorten(receipt.txHash)}` : ""), line("spay-receipt-note", receipt.disclosure));
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
  padding:16px;max-width:340px;font:14px/1.45 system-ui,sans-serif}
.spay-amount{font-size:22px;font-weight:700;margin-bottom:2px}
.spay-memo{font-size:12px;font-weight:400;color:var(--spay-muted)}
.spay-btn{width:100%;margin-top:10px;padding:10px 14px;border:0;border-radius:8px;cursor:pointer;
  background:var(--spay-accent);color:#08110a;font-weight:700;font-size:14px}
.spay-btn:disabled{opacity:.75;cursor:progress}
.spay-status{min-height:1.4em;margin-top:8px;font-size:12.5px;color:var(--spay-muted)}
.spay-status-popup{color:var(--spay-accent)}
.spay-status-popup::before{content:"↗ ";font-weight:700}
.spay-status-error{color:var(--spay-danger)}
.spay-honesty{margin-top:10px;border-top:1px solid #2a2e37;padding-top:8px;font-size:12.5px}
.spay-honesty summary{cursor:pointer;color:var(--spay-muted)}
.spay-honesty-row{display:flex;gap:8px;margin-top:8px}
.spay-badge{flex:0 0 auto;height:fit-content;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700}
.spay-badge-public{background:#3d2a2a;color:var(--spay-danger)}
.spay-badge-hidden{background:#22321f;color:var(--spay-accent)}
.spay-honesty-fact{font-weight:600}
.spay-honesty-detail{color:var(--spay-muted)}
.spay-receipt{margin-top:10px}
.spay-receipt-title{font-weight:700;color:var(--spay-accent)}
.spay-receipt-row{font-size:12.5px;margin-top:4px}
.spay-receipt-note{font-size:12px;color:var(--spay-muted);margin-top:8px;border-top:1px solid #2a2e37;padding-top:8px}
`;
    document.head.append(style);
}
