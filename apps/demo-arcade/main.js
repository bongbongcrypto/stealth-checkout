// Demo arcade wiring: this page is a "merchant" that sells game credits
// through the strk20-pay widget. Today it runs on MockWallet; the Sepolia
// adapter drops in behind the same interface without touching this file.
import { MockWallet, mountCheckout } from "../../packages/strk20-pay/dist/index.js";
import { createGame } from "./game.js";

const canvas = document.getElementById("screen");
const creditsEl = document.getElementById("credits");
const startBtn = document.getElementById("start");
const practiceBtn = document.getElementById("practice");
const coinBtn = document.getElementById("coin");
const checkoutHost = document.getElementById("checkout");
const boardEl = document.getElementById("board");

let credits = 0;
let mounted = null;
let coinSeq = 0;
/**
 * True from the moment the payer clicks pay until the payment settles or
 * fails. Pressing INSERT COIN during that window used to unmount the widget
 * while the payment kept running in the wallet: the money left, the listener
 * that grants the credit died with the widget, and the replacement invoice
 * carried a brand-new id, so the duplicate-payment guard never saw it either.
 */
let paying = false;

// One wallet per visitor session, funded with play money. The full flow:
// shield (public, screened) → note maturation → private payment: runs
// exactly as it will on Sepolia/mainnet, just faster.
const wallet = new MockWallet({ funded: { STRK: "25" }, latency: 650 });

const game = createGame(canvas, {
  onGameOver({ score, mode }) {
    saveScore(score, mode === "paid");
    renderBoard();
    updateButtons();
    game.idle();
  },
});

function freshInvoice() {
  coinSeq += 1;
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const suffix = Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    id: `coin-${String(coinSeq).padStart(3, "0")}`,
    token: "STRK",
    amount: "1",
    memo: "Shadow Run: 1 credit",
    mode: "address",
    // Fresh per-invoice receive address: this is what makes headless
    // confirmation possible while the payer stays unlinkable.
    receiveAddress: `0x0${suffix}`,
    network: wallet.network,
    createdAt: Date.now(),
  };
}

// Merchant-side confirmation stub. In production this is the RPC watcher
// (server/watcher) seeing the payment land on the invoice address.
async function watcherConfirm() {
  await new Promise((r) => setTimeout(r, 900));
  return true;
}

function insertCoin() {
  if (paying) return; // never tear down a checkout that is spending money
  mounted?.unmount();
  mounted = mountCheckout(checkoutHost, {
    invoice: freshInvoice(),
    wallet,
    confirm: watcherConfirm,
    // The arcade opts in to inline shielding because the mock wallet has no
    // wallet UI to send players to. Real merchants should leave this off.
    allowInlineShield: true,
    onPaid() {
      paying = false;
      credits += 1;
      updateButtons();
    },
    onFailed() {
      paying = false;
      updateButtons();
    },
  });
  // Any phase past "idle" means a wallet action is either open or already
  // broadcast, so the widget must survive until it reaches a terminal state.
  mounted.checkout.on((event) => {
    if (event.type !== "progress") return;
    const live = !["idle", "paid", "failed", "expired"].includes(event.progress.phase);
    if (live !== paying) {
      paying = live;
      updateButtons();
    }
  });
}

function updateButtons() {
  creditsEl.textContent = String(credits);
  startBtn.disabled = credits < 1 || game.isRunning() || paying;
  practiceBtn.disabled = game.isRunning();
  coinBtn.disabled = game.isRunning() || paying;
  coinBtn.textContent = paying ? "PAYING\u2026" : "INSERT COIN";
  coinBtn.title = paying ? "A payment is in progress: it must finish before another coin" : "";
}

startBtn.addEventListener("click", () => {
  if (credits < 1 || game.isRunning() || paying) return;
  credits -= 1;
  updateButtons();
  game.start("paid");
  canvas.focus();
  updateButtons();
});

practiceBtn.addEventListener("click", () => {
  if (game.isRunning()) return;
  game.start("practice");
  canvas.focus(); // keyboard control should not require a second click
  updateButtons();
});

coinBtn.addEventListener("click", insertCoin);

const BOARD_KEY = "shadow-run-board";

/** A corrupt or foreign value under our key must not blank the page. */
function readBoard() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BOARD_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((r) => r && Number.isFinite(r.score)) : [];
  } catch {
    return [];
  }
}

function saveScore(score, paid) {
  const board = readBoard();
  board.push({ score, paid, at: Date.now() });
  board.sort((a, b) => b.score - a.score);
  try {
    localStorage.setItem(BOARD_KEY, JSON.stringify(board.slice(0, 5)));
  } catch {
    // A full or disabled store costs a high score, not the session.
  }
}

function renderBoard() {
  const board = readBoard();
  boardEl.replaceChildren(
    ...board.map((row) => {
      const li = document.createElement("li");
      li.textContent = `${String(row.score).padStart(6, "0")}`;
      if (row.paid) {
        const badge = document.createElement("span");
        badge.className = "paid-badge";
        badge.textContent = "PAID";
        li.append(badge);
      }
      return li;
    }),
  );
}

renderBoard();
updateButtons();
insertCoin();

// Touch controls. The game reads keyboard state off `window`, so the pad
// speaks the same language rather than reaching into the game's internals.
// Without this the arcade was unplayable on a phone, which is where a judge
// scanning a QR code would open it.
for (const btn of document.querySelectorAll(".touchpad button")) {
  const key = btn.dataset.key;
  let down = false;
  const press = (type) => window.dispatchEvent(new KeyboardEvent(type, { key }));

  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    down = true;
    press("keydown");
    // Capture AFTER the press, and never let it throw the press away: it
    // rejects any pointer it does not recognise, and putting it first meant a
    // failed capture swallowed the keydown and the button did nothing.
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* sliding off the button will release the key instead */
    }
  });

  const release = () => {
    if (!down) return; // a stray leave must not send a keyup nobody asked for
    down = false;
    press("keyup");
  };
  for (const end of ["pointerup", "pointercancel", "pointerleave"]) {
    btn.addEventListener(end, release);
  }
}
