// Merchant dashboard: a thin client over the watcher's REST API.
// If the watcher is unreachable (e.g. viewing the static demo on Pages),
// it falls back to read-only demo data so the flow is still visible.

const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const demoNote = document.getElementById("demo-note");
const watcherInput = document.getElementById("f-watcher");

watcherInput.value = localStorage.getItem("spay-watcher-url") ?? watcherInput.value;
const tokenInput = document.getElementById("f-token");
tokenInput.value = localStorage.getItem("spay-watcher-token") ?? "";

/** The watcher requires a bearer token; without it every call is a 401. */
function authHeaders() {
  const token = tokenInput.value.trim();
  localStorage.setItem("spay-watcher-token", token);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const DEMO_ROWS = [
  { id: "inv_demo1", amount: "2", token: "STRK", receiveAddress: "0x04a1…fresh1", status: "paid", txHash: "0x07c0…9f2a" },
  { id: "inv_demo2", amount: "5", token: "STRK", receiveAddress: "0x00b7…fresh2", status: "watching" },
  { id: "inv_demo3", amount: "1.5", token: "STRK", receiveAddress: "0x09cc…fresh3", status: "expired" },
];

function watcherUrl() {
  const url = watcherInput.value.trim().replace(/\/$/, "");
  localStorage.setItem("spay-watcher-url", url);
  return url;
}

function short(addr) {
  return addr && addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : (addr ?? "");
}

/** States that must never be handed to a payer: the watcher will not confirm them. */
const UNPAYABLE = new Set(["reserving", "expired", "needs_reregistration", "paid"]);

function payLink(inv) {
  // A link for an invoice the watcher is not watching takes the payer's money
  // and never fires a webhook: money in, order never shipped.
  if (UNPAYABLE.has(inv.status)) return "";
  if (!/^0x[0-9a-fA-F]{10,}$/.test(inv.receiveAddress ?? "")) return "";
  const base = new URL("../pay-live/index.html", location.href);
  base.search = new URLSearchParams({ to: inv.receiveAddress, amount: inv.amount, id: inv.id }).toString();
  return base.toString();
}

function render(invoices, demo) {
  demoNote.hidden = !demo;
  rowsEl.replaceChildren(
    ...invoices.map((inv) => {
      const tr = document.createElement("tr");
      const cells = [
        inv.id,
        `${inv.amount} ${inv.token ?? "STRK"}`,
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
      badge.className = `badge b-${["watching", "paid", "expired"].includes(status) ? status : "attention"}`;
      badge.textContent = status.replace(/_/g, " ").toUpperCase();
      if (status === "needs_reregistration") badge.title = "No baseline: delete this row and create it again";
      if (status === "reserving") badge.title = "Registration did not finish; delete this row and try again";
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
      if (!demo && UNPAYABLE.has(inv.status) && inv.status !== "paid") {
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
  }
}

document.getElementById("f-create").addEventListener("click", async () => {
  const id = document.getElementById("f-id").value.trim();
  const amount = document.getElementById("f-amount").value.trim();
  const to = document.getElementById("f-to").value.trim();
  statusEl.textContent = "creating…";
  try {
    const res = await fetch(`${watcherUrl()}/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ ...(id ? { id } : {}), token: "STRK", amount, receiveAddress: to }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "create failed");
    await refresh();
  } catch (err) {
    statusEl.textContent = `error: ${err.message}`;
  }
});

document.getElementById("f-refresh").addEventListener("click", refresh);
setInterval(refresh, 10_000);
void refresh();
