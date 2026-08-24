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

// One wallet per visitor session, with play money on both sides.
//
// It starts with a SHIELDED balance because that is the flow the product
// actually recommends: shield once, ahead of time, then spend from it. A coin
// then costs 1 + the pool's 6 STRK fee, and there is no public deposit leg to
// correlate.
//
// It also has to be enough. Funded with 25 public and nothing shielded, the
// first coin consumed 13 (deposit 1 + 6 + 6) and the second could not be
// afforded at all: a judge who pressed INSERT COIN twice, which the UI invites,
// watched the demo break with "Insufficient STRK balance" and no way back.
const wallet = new MockWallet({ funded: { STRK: "200" }, shielded: { STRK: "70" }, latency: 650 });

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
    onFailed(error) {
      paying = false;
      updateButtons();
      // A demo that dead-ends on an error with no way back is worse than one
      // that never started. Play money is finite; say what to do about it.
      if (/insufficient|not enough|credit nothing/i.test(error)) {
        const note = document.createElement("p");
        note.className = "pitch";
        note.style.color = "#f0c674";
        note.textContent =
          "That is the play money gone. Reload the page for a fresh wallet. On mainnet this is exactly the " +
          "moment the widget tells you to shield more, in one go and ahead of time, rather than per purchase.";
        checkoutHost.append(note);
      }
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

/**
 * Put the pay button where it can be seen, once the widget has settled.
 *
 * Pressing INSERT COIN used to change nothing a visitor could see: the checkout
 * mounts in the right-hand column, and its button sat below the fold. An audit
 * measured 699px on a laptop and 1298 on a phone, and clicking through the flow
 * never caught it, because whoever clicks already knows where the button is.
 *
 * The wait matters. The panel fills in asynchronously, so a check on the next
 * frame measures a box that has not grown yet, decides everything is visible,
 * and does nothing. This waits for the height to stop moving first.
 */
async function revealPayButton() {
  let previous = -1;
  for (let i = 0; i < 20; i++) {
    const height = checkoutHost.getBoundingClientRect().height;
    if (height === previous && height > 0) break;
    previous = height;
    // A timer rather than requestAnimationFrame: rAF does not tick in a view
    // that is not compositing, and this loop then never finishes, which is how
    // the scroll came to silently do nothing.
    await new Promise((r) => setTimeout(r, 32));
  }

  const pay = checkoutHost.querySelector("button");
  if (!pay) return;
  const r = pay.getBoundingClientRect();
  // Only when it is needed. A page that jumps when nothing moved out of view is
  // its own annoyance, and on a wide screen the button is already there.
  const margin = 24;
  if (r.bottom > window.innerHeight - margin || r.top < margin) {
    // Instant rather than smooth: smooth silently does nothing in some embedded
    // views, and a scroll that quietly fails is the defect this is here to fix.
    pay.scrollIntoView({ block: "center" });
  }
}

coinBtn.addEventListener("click", () => {
  insertCoin();
  // Pressing INSERT COIN used to change nothing a visitor could see: the
  // checkout mounts in the right-hand column, and on a laptop its pay button
  // sat below the fold. A layout audit measured 699px on a desktop and 1298 on
  // a phone. The panel is shorter now, and the page also goes to it, because a
  // primary action that requires a scroll to discover is not one.
  //
  // Only on the click. `insertCoin()` also runs once at load, and a page that
  // scrolls itself the moment it opens is its own defect.
  void revealPayButton();
});

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
