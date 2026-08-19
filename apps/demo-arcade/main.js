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
  mounted?.unmount();
  mounted = mountCheckout(checkoutHost, {
    invoice: freshInvoice(),
    wallet,
    confirm: watcherConfirm,
    onPaid() {
      credits += 1;
      updateButtons();
    },
  });
}

function updateButtons() {
  creditsEl.textContent = String(credits);
  startBtn.disabled = credits < 1 || game.isRunning();
  practiceBtn.disabled = game.isRunning();
  coinBtn.disabled = game.isRunning();
}

startBtn.addEventListener("click", () => {
  if (credits < 1 || game.isRunning()) return;
  credits -= 1;
  updateButtons();
  game.start("paid");
  updateButtons();
});

practiceBtn.addEventListener("click", () => {
  if (game.isRunning()) return;
  game.start("practice");
  updateButtons();
});

coinBtn.addEventListener("click", insertCoin);

const BOARD_KEY = "shadow-run-board";

function saveScore(score, paid) {
  const board = JSON.parse(localStorage.getItem(BOARD_KEY) ?? "[]");
  board.push({ score, paid, at: Date.now() });
  board.sort((a, b) => b.score - a.score);
  localStorage.setItem(BOARD_KEY, JSON.stringify(board.slice(0, 5)));
}

function renderBoard() {
  const board = JSON.parse(localStorage.getItem(BOARD_KEY) ?? "[]");
  boardEl.replaceChildren(
    ...board.map((row, i) => {
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
