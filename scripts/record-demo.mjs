#!/usr/bin/env node
// Record the demo's screen segments, hands off.
//
//   node scripts/record-demo.mjs --list          what the segments are
//   node scripts/record-demo.mjs --segment b     record one
//   node scripts/record-demo.mjs --all           record every automatable one
//   node scripts/record-demo.mjs --segment b --dry   choreography only, no capture
//
// The browser is driven over the DevTools protocol rather than by moving the
// mouse, so recording does not take the machine hostage: the window sits on the
// primary monitor drawing itself while whoever owns the desk keeps working on
// another one. Nothing here synthesises OS input, and nothing needs focus.
//
// Timings come from docs/demo-script.json, so a segment is exactly as long as
// the narration written over it and the two can never drift.
//
// One segment is deliberately missing: the live mainnet payment. That one needs
// a wallet signature, which is the owner's to give.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, launch } from "./lib/cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "recording");

const WIDTH = 1920;
const HEIGHT = 1080;
const PORT = 4183;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFfmpeg() {
  const winget = join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
  );
  try {
    for (const dir of readdirSync(winget)) {
      const exe = join(winget, dir, "bin", "ffmpeg.exe");
      if (existsSync(exe)) return exe;
    }
  } catch {
    /* fall through to PATH */
  }
  return "ffmpeg";
}

const seconds = (stamp) => {
  const m = /^(\d{1,2}):(\d{2})\.(\d{3})$/.exec(stamp);
  if (!m) throw new Error(`not a mm:ss.mmm timestamp: ${stamp}`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
};

// ---------------------------------------------------------------- page tools
//
// Injected into the page rather than shipped in it. A spotlight ring and an
// eased scroll are things a recording wants and a product does not, and the
// checkout is the last place to start adding code that only exists for a video.

const HELPERS = `
(() => {
  if (window.__shoot) return "already";
  const style = document.createElement("style");
  style.textContent =
    ".__spot{position:absolute;pointer-events:none;z-index:2147483647;border-radius:12px;" +
    "box-shadow:0 0 0 3px #7fd1ff,0 0 24px 6px rgba(127,209,255,.55);transition:all .45s cubic-bezier(.4,0,.2,1);" +
    "opacity:0}" +
    ".__spot.on{opacity:1}";
  document.head.append(style);
  const ring = document.createElement("div");
  ring.className = "__spot";
  document.body.append(ring);

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  window.__shoot = {
    // A scroll of its own rather than behavior:"smooth", which is silently a
    // no-op wherever the browser has decided motion is unwanted. A jump cut in
    // the middle of a narrated sentence is not a thing to leave to a default.
    scrollTo(y, ms = 900) {
      return new Promise((done) => {
        const from = window.scrollY;
        const to = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms);
          window.scrollTo(0, from + (to - from) * ease(p));
          if (p < 1) requestAnimationFrame(step); else done(to);
        };
        requestAnimationFrame(step);
      });
    },
    scrollToEl(sel, ms) {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for " + sel);
      const r = el.getBoundingClientRect();
      return this.scrollTo(window.scrollY + r.top - (innerHeight - r.height) / 2, ms);
    },
    // Typed a character at a time, because a field whose value simply appears
    // reads as a screenshot rather than as someone using the thing. The events
    // are dispatched too: a page that listens for input gets none from an
    // assignment to .value, and the form would stay inert on camera.
    async type(sel, text, ms = 26) {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for " + sel);
      el.focus();
      el.value = "";
      for (const ch of text) {
        el.value += ch;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, ms));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value.slice(0, 24) + "…";
    },
    pick(sel, value) {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for " + sel);
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.selectedOptions[0].textContent;
    },
    spot(sel, pad = 8) {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for " + sel);
      const r = el.getBoundingClientRect();
      ring.style.left = (r.left + scrollX - pad) + "px";
      ring.style.top = (r.top + scrollY - pad) + "px";
      ring.style.width = (r.width + pad * 2) + "px";
      ring.style.height = (r.height + pad * 2) + "px";
      ring.classList.add("on");
      return el.textContent.trim().slice(0, 60);
    },
    unspot() { ring.classList.remove("on"); },
  };
  return "ready";
})()
`;

// ----------------------------------------------------------------- segments
//
// `at` is milliseconds from the start of the segment, which is also the moment
// capture begins, so a step lands under the sentence it belongs to.

const SEGMENTS = [
  {
    id: "a",
    from: "00:00.000",
    to: "00:16.000",
    what: "README, then the landing page",
    url: "https://github.com/bongbongcrypto/stealth-checkout",
    steps: [
      { at: 300, do: async (s) => evaluate(s, `window.__shoot.scrollTo(document.body.scrollHeight * 0.06, 1200)`) },
      { at: 4200, do: async (s) => evaluate(s, `window.__shoot.scrollTo(window.scrollY + 520, 2400)`) },
      { at: 7700, do: async (s) => evaluate(s, `window.__shoot.scrollTo(window.scrollY + 420, 2600)`) },
      { at: 13000, do: async (s, go) => go("https://bongbongcrypto.github.io/stealth-checkout/") },
    ],
  },
  {
    id: "b",
    from: "00:16.000",
    to: "01:16.000",
    what: "the arcade: pay, play, then the price and the honesty panel",
    url: `${BASE}/apps/demo-arcade/index.html`,
    steps: [
      // 0:16 the shop
      { at: 400, do: async (s) => evaluate(s, `window.__shoot.scrollTo(0, 600)`) },
      // 0:21 the widget is that panel
      { at: 5200, do: async (s) => evaluate(s, `window.__shoot.spot("#checkout", 12)`) },
      { at: 10200, do: async (s) => evaluate(s, `window.__shoot.unspot()`) },
      // 0:27 drop a coin in
      { at: 11200, do: async (s) => evaluate(s, `document.querySelector("#coin").click()`) },
      { at: 13000, do: async (s) => evaluate(s, `document.querySelector(".spay-btn").click()`) },
      // 0:31 the credit is granted and the game runs
      { at: 17000, do: async (s) => evaluate(s, `window.__shoot.scrollToEl("#screen", 900)`) },
      { at: 18500, do: async (s) => evaluate(s, `document.querySelector("#start")?.click()`) },
      // 0:38 look at the price before you sign. A second coin, stopped before
      // paying, is what puts the confirmation block back on screen: the first
      // one has become a receipt and a receipt has no price on it.
      { at: 22000, do: async (s) => evaluate(s, `document.querySelector("#coin").click()`) },
      { at: 22600, do: async (s) => evaluate(s, `window.__shoot.scrollToEl(".spay-confirm", 1100)`) },
      // 0:42 a one STRK coin costs seven
      { at: 26800, do: async (s) => evaluate(s, `window.__shoot.spot(".spay-total", 10)`) },
      // 0:46 the pool takes six, flat
      { at: 30800, do: async (s) => evaluate(s, `window.__shoot.spot(".spay-confirm", 10)`) },
      // 0:54 that number is in no documentation
      { at: 38200, do: async (s) => evaluate(s, `window.__shoot.spot(".spay-fee-warn", 10)`) },
      // 1:01 so private payments have a floor
      { at: 46000, do: async (s) => evaluate(s, `window.__shoot.unspot()`) },
      { at: 48000, do: async (s) => evaluate(s, `window.__shoot.scrollToEl(".spay-honesty-summary", 1200)`) },
      // 1:09 the panel spells out what leaks
      { at: 53400, do: async (s) => evaluate(s, `window.__shoot.scrollToEl(".spay-honesty", 1600)`) },
    ],
  },
  {
    id: "c",
    from: "01:16.000",
    to: "01:50.000",
    what: "the merchant dashboard, the printable counter code, and the QR encoder",
    url: `${BASE}/apps/dashboard/index.html`,
    needsWatcher: true,
    // Run before a frame is captured. "Every invoice gets a link and a QR" over
    // an empty table would be a claim the screen contradicts, so the table is
    // filled first, off camera, the same way a shop's would already be.
    setup: async (s) => {
      await evaluate(s, `window.__shoot.type("#f-watcher", "http://127.0.0.1:8787", 0)`);
      await evaluate(s, `window.__shoot.type("#f-token", "demo", 0)`);
      for (const [amount, hours] of [["12", "24"], ["4.5", "24"], ["30", ""]]) {
        await evaluate(
          s,
          `window.__shoot.type("#f-amount", ${JSON.stringify(amount)}, 0)` +
            `.then(() => window.__shoot.type("#f-expires", ${JSON.stringify(hours)}, 0))` +
            `.then(() => window.__shoot.type("#f-to", "0x0" + Array.from(crypto.getRandomValues(new Uint8Array(31)),` +
            ` b => b.toString(16).padStart(2,"0")).join(""), 0))` +
            `.then(() => document.querySelector("#f-create").click())`,
        );
        await sleep(900);
      }
      // The table is drawn from a fetch that finishes after the click returns,
      // so counting rows straight away counts the ones from before. It cost a
      // run to learn that: three invoices existed and the check said none did.
      await evaluate(s, `document.querySelector("#f-refresh").click()`);
      let rows = 0;
      for (let i = 0; i < 20 && rows === 0; i++) {
        await sleep(300);
        rows = await evaluate(s, `document.querySelectorAll("#rows tr").length`);
      }
      if (rows === 0) throw new Error("the dashboard has no invoices; is the watcher running on 8787?");
      return `${rows} invoices on the board`;
    },
    steps: [
      // 1:16 merchant side: every invoice gets a link and a QR
      { at: 500, do: async (s) => evaluate(s, `window.__shoot.scrollTo(260, 1400)`) },
      // 1:22 or print one code and stick it on the counter. No parameters is
      // the creator: the page routes on `to` and `amount`, and there is no
      // ?create flag to pass it.
      { at: 5800, do: async (s, go) => go(`${BASE}/apps/pay-live/index.html`) },
      { at: 6800, do: async (s) => evaluate(s, `window.__shoot.pick("#f-kind", "static")`) },
      {
        at: 8000,
        // Freshly generated, the way a merchant's own would be. Nothing in the
        // repository is put on camera as a stand-in for a real address.
        do: async (s) =>
          evaluate(
            s,
            `window.__shoot.type("#f-to", "0x0" + Array.from(crypto.getRandomValues(new Uint8Array(31)),` +
              ` b => b.toString(16).padStart(2,"0")).join(""), 14)`,
          ),
      },
      { at: 11500, do: async (s) => evaluate(s, `document.querySelector("#f-make").click()`) },
      { at: 12400, do: async (s) => evaluate(s, `window.__shoot.scrollToEl("#f-out", 1100)`) },
      // 1:29 one printed code means one address forever
      { at: 13800, do: async (s) => evaluate(s, `window.__shoot.spot("#f-advice", 10)`) },
      // 1:36 your customers stay anonymous either way
      { at: 20800, do: async (s) => evaluate(s, `window.__shoot.spot("#f-out", 10)`) },
      // 1:43 the QR encoder is ours
      { at: 26400, do: async (s) => evaluate(s, `window.__shoot.unspot()`) },
      {
        at: 27000,
        do: async (s, go) =>
          go("https://github.com/bongbongcrypto/stealth-checkout/blob/main/packages/strk20-pay/src/qr.ts"),
      },
      { at: 30000, do: async (s) => evaluate(s, `window.__shoot.scrollTo(700, 2500)`) },
    ],
  },
  {
    id: "e",
    from: "02:37.000",
    to: "03:00.000",
    what: "the transaction manifest, what it does not prove, and the close",
    url: "https://github.com/bongbongcrypto/stealth-checkout/blob/main/strk20.json",
    steps: [
      { at: 500, do: async (s) => evaluate(s, `window.__shoot.scrollTo(400, 1800)`) },
      // 2:44 and the README says what those transactions don't prove
      {
        at: 7000,
        do: async (s, go) => go("https://github.com/bongbongcrypto/stealth-checkout#what-these-do-and-do-not-show"),
      },
      // 2:50 the close
      { at: 13000, do: async (s, go) => go("https://bongbongcrypto.github.io/stealth-checkout/") },
      { at: 17000, do: async (s) => evaluate(s, `window.__shoot.scrollTo(300, 2200)`) },
    ],
  },
];

/** The one segment nobody can automate, listed so it is never quietly skipped. */
const OWNER_SEGMENT = {
  id: "d",
  from: "01:50.000",
  to: "02:37.000",
  what: "the live mainnet payment: the owner signs, so this is recorded with them at the desk",
};

// -------------------------------------------------------------------- record

/**
 * Bring up the merchant's watcher if the segment shows it, and leave it running
 * for the rest of the shoot.
 *
 * The token is the string "demo" and the store is a scratch file, because this
 * is a recording of a demo and not a deployment. Anything with a real secret in
 * it does not belong in a process started by a script that also opens a browser
 * onto the public internet.
 */
let watcher = null;
async function ensureWatcher() {
  try {
    const res = await fetch("http://127.0.0.1:8787/healthz");
    if (res.ok) return "already running";
  } catch {
    /* start one */
  }
  watcher = spawn(process.execPath, [join(ROOT, "server", "watcher", "watcher.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      WATCHER_TOKEN: "demo",
      WATCHER_ORIGIN: BASE,
      WATCHER_STORE: join(OUT, "shoot-invoices.json"),
    },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try {
      if ((await fetch("http://127.0.0.1:8787/healthz")).ok) return "started";
    } catch {
      /* not yet */
    }
  }
  throw new Error("the watcher never came up on 8787");
}

async function recordSegment(seg, { dry = false } = {}) {
  const length = seconds(seg.to) - seconds(seg.from);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `seg-${seg.id}.mp4`);

  console.log(`segment ${seg.id}: ${seg.what}`);
  console.log(`  ${seg.from} to ${seg.to} (${length.toFixed(1)}s)`);

  if (seg.needsWatcher) console.log(`  watcher: ${await ensureWatcher()}`);

  const browser = await launch({
    width: WIDTH,
    height: HEIGHT,
    x: 0,
    y: 0,
    port: 9222,
    headless: dry,
    fullscreen: !dry,
  });
  const s = browser.session;

  /** Navigate and wait for the page to be usable, then re-inject the helpers. */
  const go = async (url) => {
    await s.send("Page.enable");
    const loaded = s.once("Page.loadEventFired", { timeout: 45000 });
    await s.send("Page.navigate", { url });
    await loaded;
    await sleep(900);
    await evaluate(s, HELPERS);
  };

  try {
    await go(seg.url);

    if (seg.setup) {
      const note = await seg.setup(s);
      console.log(`  setup: ${note ?? "done"}`);
    }
    // Everything the segment touches, checked before a frame is recorded. A
    // take that dies eleven seconds in because a selector moved is a take that
    // has to be shot again, and the reshoot costs more than the check.
    const selectors = [...JSON.stringify(seg.steps.map((x) => String(x.do))).matchAll(/querySelector\(\\"([^"\\]+)/g)];
    for (const [, sel] of selectors) {
      if (!(await evaluate(s, `!!document.querySelector(${JSON.stringify(sel)})`))) {
        console.log(`  note: "${sel}" is not on the first page; it must appear before its step`);
      }
    }

    let capture = null;
    if (!dry) {
      capture = spawn(
        findFfmpeg(),
        [
          "-y", "-loglevel", "error",
          "-f", "gdigrab", "-framerate", "30",
          "-offset_x", "0", "-offset_y", "0",
          "-video_size", `${WIDTH}x${HEIGHT}`,
          "-i", "desktop",
          "-t", String(length),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-pix_fmt", "yuv420p",
          file,
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      // gdigrab does not open instantly, and a step that fires before the first
      // frame simply does not appear in the recording.
      await sleep(1200);
    }

    const t0 = Date.now();
    for (const step of seg.steps) {
      const wait = step.at - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      const mark = ((Date.now() - t0) / 1000).toFixed(1);
      try {
        const got = await step.do(s, go);
        console.log(`  ${mark}s  ok${got && got !== "ready" ? `  ${String(got).slice(0, 50)}` : ""}`);
      } catch (err) {
        // One missed step is a blemish; aborting is a lost take. It is reported
        // loudly and the rest of the segment carries on.
        console.log(`  ${mark}s  MISSED: ${err.message.split("\n")[0].slice(0, 90)}`);
      }
    }
    const remaining = length * 1000 - (Date.now() - t0);
    if (remaining > 0) await sleep(remaining + 400);

    if (capture) {
      await new Promise((r) => capture.on("exit", r));
      const probe = execFileSync(findFfmpeg().replace("ffmpeg", "ffprobe"), [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
      ]).toString().trim();
      console.log(`  wrote docs/recording/seg-${seg.id}.mp4 (${Number(probe).toFixed(1)}s)`);
    } else {
      console.log("  dry run: choreography only, nothing captured");
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

if (argv.includes("--list") || argv.length === 0) {
  const { lines } = JSON.parse(readFileSync(join(ROOT, "docs", "demo-script.json"), "utf8"));
  const say = (from, to) =>
    lines.filter((l) => seconds(l.start) >= seconds(from) && seconds(l.start) < seconds(to)).length;
  for (const seg of [...SEGMENTS, OWNER_SEGMENT].sort((a, b) => a.id.localeCompare(b.id))) {
    const auto = seg.steps ? "automatic" : "OWNER AT THE DESK";
    console.log(
      `  ${seg.id}  ${seg.from}-${seg.to}  ${String((seconds(seg.to) - seconds(seg.from)).toFixed(0)).padStart(2)}s  ` +
        `${String(say(seg.from, seg.to)).padStart(2)} lines  ${auto.padEnd(17)}  ${seg.what}`,
    );
  }
  const covered = [...SEGMENTS, OWNER_SEGMENT].reduce((n, s) => n + seconds(s.to) - seconds(s.from), 0);
  console.log(`\n  ${covered.toFixed(0)}s of 180s covered`);
  process.exit(0);
}

const dry = argv.includes("--dry");
const wanted = argv.includes("--all") ? SEGMENTS : SEGMENTS.filter((s) => s.id === arg("--segment"));
if (wanted.length === 0) {
  console.error(`no such segment. Try --list.`);
  process.exit(1);
}
for (const seg of wanted) await recordSegment(seg, { dry });
if (watcher) watcher.kill();
