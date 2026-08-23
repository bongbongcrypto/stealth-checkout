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

function payLink(inv) {
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
      badge.className = `badge b-${inv.status}`;
      badge.textContent = inv.status.toUpperCase();
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
      if (link && !demo) {
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
