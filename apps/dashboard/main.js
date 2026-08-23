// Merchant dashboard: a thin client over the watcher's REST API.
// If the watcher is unreachable (e.g. viewing the static demo on Pages),
// it falls back to read-only demo data so the flow is still visible.

const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const demoNote = document.getElementById("demo-note");
const watcherInput = document.getElementById("f-watcher");

const tokenInput = document.getElementById("f-token");

// The token is NOT persisted, and the URL only is when this page is served
// from a host of its own.
//
// github.io gives every Pages site on an account the SAME origin, so anything
// in localStorage there is readable by any other page that account publishes,
// and a hostile sibling could also rewrite the saved watcher URL and have this
// dashboard post `Authorization: Bearer <token>` to it every ten seconds. A
// merchant API token is not worth that convenience: retype it, or serve the
// dashboard from your own host.
const PERSISTENCE_IS_SAFE = !/(^|\.)github\.io$/i.test(location.hostname) && location.protocol !== "file:";
if (PERSISTENCE_IS_SAFE) {
  watcherInput.value = localStorage.getItem("spay-watcher-url") ?? watcherInput.value;
}

/** The watcher requires a bearer token; without it every call is a 401. */
function authHeaders() {
  const token = tokenInput.value.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Sample rows for when the watcher is unreachable. The hashes and addresses
// are REAL mainnet ones from this project's own transactions: the placeholder
// "0x07c0…9f2a" that used to sit here rendered as a link straight to a Voyager
// 404, which is a worse first impression than no link at all.
const DEMO_ROWS = [
  {
    id: "inv_demo1",
    amount: "2",
    token: "STRK",
    // Addresses here are illustrative. The hash is not: it is a real mainnet
    // transaction from this project, so the Voyager link resolves. The
    // truncated placeholder that used to sit here linked to a 404, which is a
    // worse first impression than no link at all.
    receiveAddress: "0x07c0000000000000000000000000000000000000000000000000000009f2a",
    status: "paid",
    txHash: "0x5a054090852c5719b99b617fcf1886a141613864623eda9d9fabb70b104629d",
  },
  {
    id: "inv_demo2",
    amount: "5",
    token: "STRK",
    receiveAddress: "0x04a1000000000000000000000000000000000000000000000000000000000b1",
    status: "watching",
    receivedUnits: "2000000000000000000",
    decimals: 18,
  },
  {
    id: "inv_demo3",
    amount: "1.5",
    token: "STRK",
    receiveAddress: "0x09cc000000000000000000000000000000000000000000000000000000000c3",
    status: "underpaid",
    receivedUnits: "500000000000000000",
    shortfallUnits: "1000000000000000000",
    decimals: 18,
  },
  {
    id: "inv_demo4",
    amount: "1",
    token: "STRK",
    receiveAddress: "0x00b7000000000000000000000000000000000000000000000000000000000b4",
    status: "expired",
  },
];

function watcherUrl() {
  const url = watcherInput.value.trim().replace(/\/$/, "");
  if (PERSISTENCE_IS_SAFE) localStorage.setItem("spay-watcher-url", url);
  return url;
}

function short(addr) {
  return addr && addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : (addr ?? "");
}

// These two sets answer different questions and are kept apart on purpose, in
// step with server/watcher/lib.mjs. An underpaid invoice is unpayable AND
// undeletable: real money is already sitting at its address, and releasing the
// address for reuse would let a later invoice settle on it.

/** Never hand these to a payer: the watcher will not confirm them. */
const UNPAYABLE = new Set(["reserving", "expired", "needs_reregistration", "paid", "paid_late", "underpaid"]);

/** Only these may be released. */
const DELETABLE = new Set(["reserving", "expired", "needs_reregistration"]);

const STATUS_HELP = {
  needs_reregistration: "No baseline: delete this row and create it again",
  reserving: "Registration did not finish; delete this row and try again",
  underpaid: "Money arrived but not enough. The address is NOT released: sweep or refund it by hand",
  paid_late: "Paid after the deadline, inside the grace window. Your call whether to honour it",
  expired: "Deadline passed with nothing received",
};

const BADGE_CLASS = {
  watching: "b-watching",
  paid: "b-paid",
  paid_late: "b-paid",
  expired: "b-expired",
};

/** Integer units back to a readable amount, for the partial-payment column. */
function fromUnits(units, decimals = 18) {
  try {
    const n = BigInt(units);
    const base = 10n ** BigInt(decimals);
    const whole = n / base;
    const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : String(whole);
  } catch {
    return "?";
  }
}

function payLink(inv) {
  // A link for an invoice the watcher is not watching takes the payer's money
  // and never fires a webhook: money in, order never shipped.
  if (UNPAYABLE.has(inv.status)) return "";
  if (!/^0x[0-9a-fA-F]{10,}$/.test(inv.receiveAddress ?? "")) return "";
  const base = new URL("../pay-live/index.html", location.href);
  const watcher = watcherUrl();
  base.search = new URLSearchParams({
    to: inv.receiveAddress,
    amount: inv.amount,
    id: inv.id,
    // Name this watcher in the link so the payer's page takes the amount from
    // the server rather than from the query string it was handed. Only over
    // https or loopback: the page refuses anything else, and a link the page
    // will refuse is worse than one that simply omits the watcher.
    ...(/^(https:|http:\/\/(localhost|127\.0\.0\.1)([:/]|$))/.test(watcher) ? { watcher } : {}),
  }).toString();
  return base.toString();
}

function render(invoices, demo) {
  demoNote.hidden = !demo;
  rowsEl.replaceChildren(
    ...invoices.map((inv) => {
      const tr = document.createElement("tr");
      const received =
        inv.receivedUnits && inv.receivedUnits !== "0"
          ? `${fromUnits(inv.receivedUnits, inv.decimals ?? 18)} / ${inv.amount}`
          : "-";
      const cells = [
        inv.id,
        `${inv.amount} ${inv.token ?? "STRK"}`,
        received,
        short(inv.receiveAddress),
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      const st = document.createElement("td");
      const badge = document.createElement("span");
      // Unknown states must still render: a raw class name with no CSS rule
      // made a needs_reregistration row look like a normal payable one.
      const status = typeof inv.status === "string" ? inv.status : "unknown";
      badge.className = `badge ${BADGE_CLASS[status] ?? "b-attention"}`;
      badge.textContent = status.replace(/_/g, " ").toUpperCase();
      if (STATUS_HELP[status]) badge.title = STATUS_HELP[status];
      st.append(badge);
      tr.append(st);

      const tx = document.createElement("td");
      if (inv.txHash) {
        const a = document.createElement("a");
        a.href = `https://voyager.online/tx/${inv.txHash}`;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = short(inv.txHash);
        tx.append(a);
      } else {
        tx.textContent = "-";
      }
      tr.append(tx);

      const linkTd = document.createElement("td");
      const link = payLink(inv);
      if (!demo && DELETABLE.has(inv.status)) {
        const fix = document.createElement("button");
        fix.className = "ghost";
        fix.style.padding = "2px 8px";
        fix.textContent = "delete";
        fix.title = "Release this row so its id and address can be used again";
        fix.addEventListener("click", async () => {
          fix.disabled = true;
          try {
            const res = await fetch(`${watcherUrl()}/invoices/${encodeURIComponent(inv.id)}`, {
              method: "DELETE",
              headers: authHeaders(),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? "delete failed");
            await refresh();
          } catch (err) {
            statusEl.textContent = `error: ${err.message}`;
            fix.disabled = false;
          }
        });
        linkTd.append(fix);
      } else if (link && !demo) {
        const a = document.createElement("a");
        a.href = link;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = "open";
        const copy = document.createElement("button");
        copy.className = "ghost";
        copy.style.marginLeft = "8px";
        copy.style.padding = "2px 8px";
        copy.textContent = "copy";
        copy.addEventListener("click", () => {
          void navigator.clipboard.writeText(link);
          copy.textContent = "✓";
          setTimeout(() => (copy.textContent = "copy"), 1200);
        });
        linkTd.append(a, copy);
      } else {
        linkTd.textContent = "-";
      }
      tr.append(linkTd);
      return tr;
    }),
  );
}

async function refresh() {
  statusEl.textContent = "loading…";
  try {
    const res = await fetch(`${watcherUrl()}/invoices`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401) {
      render([], false);
      statusEl.textContent = "watcher rejected the token: paste the WATCHER_TOKEN you started it with";
      return;
    }
    if (!res.ok) throw new Error();
    const invoices = await res.json();
    render(invoices, false);
    const watching = invoices.filter((i) => i.status === "watching").length;
    statusEl.textContent = `watcher OK: ${watching} watching, ${invoices.length} total`;
  } catch {
    render(DEMO_ROWS, true);
    statusEl.textContent = "";
    reachable = false;
    setControlsEnabled(false);
    return;
  }
  reachable = true;
  setControlsEnabled(true);
}

let reachable = true;

/**
 * With no watcher there is nothing to create an invoice in and nothing to
 * export. Leaving the buttons live only bought the visitor a "Failed to fetch"
 * with no action attached to it.
 */
function setControlsEnabled(on) {
  for (const id of ["f-create", "f-export"]) {
    const btn = document.getElementById(id);
    btn.disabled = !on;
    btn.title = on ? "" : "Start the watcher and set its URL above first";
  }
}

document.getElementById("f-create").addEventListener("click", async () => {
  const btn = document.getElementById("f-create");
  const id = document.getElementById("f-id").value.trim();
  const amount = document.getElementById("f-amount").value.trim();
  const to = document.getElementById("f-to").value.trim();
  const hours = Number(document.getElementById("f-expires").value.trim());
  btn.disabled = true;
  statusEl.textContent = "creating…";
  try {
    const res = await fetch(`${watcherUrl()}/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A create that times out client-side has usually succeeded server-side.
        // The key makes the retry return that same invoice instead of "already
        // exists", which used to read as a failure and get retried by hand.
        "Idempotency-Key": `dash-${id || to}-${amount}`,
        ...authHeaders(),
      },
      body: JSON.stringify({
        ...(id ? { id } : {}),
        token: "STRK",
        amount,
        receiveAddress: to,
        ...(Number.isFinite(hours) && hours > 0 ? { expiresAt: Date.now() + hours * 3_600_000 } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "create failed");
    statusEl.textContent = `created ${body.id}`;
    await refresh();
  } catch (err) {
    statusEl.textContent = `error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// Reconciliation. The watcher needs a bearer token, so a plain <a download>
// cannot fetch it: pull it with the token, then hand the browser a blob.
document.getElementById("f-export").addEventListener("click", async () => {
  const btn = document.getElementById("f-export");
  btn.disabled = true;
  try {
    const res = await fetch(`${watcherUrl()}/invoices.csv`, { headers: authHeaders() });
    if (!res.ok) throw new Error(res.status === 401 ? "watcher rejected the token" : `HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = "exported invoices.csv";
  } catch (err) {
    statusEl.textContent = `export failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("f-refresh").addEventListener("click", refresh);
setInterval(refresh, 10_000);
void refresh();
