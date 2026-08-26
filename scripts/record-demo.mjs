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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, launch } from "./lib/cdp.mjs";
import { SEGMENT_SLOTS, checkSlots, seconds } from "./lib/segments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "recording");

const WIDTH = 1920;
const HEIGHT = 1080;
const PORT = 4183;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which screen to film on, from --monitor. Null means pick a spare one. */
let monitorArg = null;
/** Cut the take short, for proving the rig without sitting through a segment. */
let secondsArg = null;

/**
 * Every monitor attached, so the shoot can be sent to one nobody is using.
 *
 * This is what makes the whole thing unattended rather than merely hands-free:
 * driving the browser over a socket already means not stealing the mouse, and
 * putting the window on a second screen means not stealing the view either.
 */
function monitors() {
  const out = execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; " +
      "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
      "'{0},{1},{2},{3},{4}' -f $_.Bounds.X,$_.Bounds.Y,$_.Bounds.Width,$_.Bounds.Height,$_.Primary }",
  ]).toString();
  return out
    .trim()
    .split(/\r?\n/)
    .map((line, i) => {
      const [x, y, w, h, primary] = line.split(",");
      return { index: i, x: Number(x), y: Number(y), width: Number(w), height: Number(h), primary: primary === "True" };
    })
    .sort((a, b) => a.x - b.x);
}

/** The screen to shoot on: a named one, else the largest that is not primary. */
function pickMonitor(wanted) {
  const all = monitors();
  if (wanted !== null) {
    const found = all[Number(wanted)];
    if (!found) throw new Error(`no monitor ${wanted}; there are ${all.length} (0 to ${all.length - 1})`);
    return found;
  }
  const spare = all.filter((m) => !m.primary && m.width >= WIDTH && m.height >= HEIGHT);
  // A screen to the LEFT of the primary one has a negative origin, and gdigrab
  // takes its offsets as plain integers. Rather than find out mid-shoot whether
  // it handles that, a screen at a positive origin wins when there is one; the
  // negative case still works if it is asked for by number.
  //
  // Falling back to the primary is correct but worth saying out loud, because
  // it is the difference between a shoot someone can work through and one that
  // takes their desk.
  const rank = (m) => (m.x < 0 || m.y < 0 ? 1 : 0);
  return (
    spare.sort((a, b) => rank(a) - rank(b) || b.width * b.height - a.width * a.height)[0] ??
    all.find((m) => m.primary)
  );
}

/**
 * ffmpeg or ffprobe, by name.
 *
 * By name rather than by patching "ffmpeg" into "ffprobe" in the path this
 * returns: the winget layout puts the word in the folder as well as the file,
 * so a replace hit `ffmpeg-8.1.1-full_build` and produced a path to nothing.
 */
function findFfmpeg(name = "ffmpeg") {
  const winget = join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
  );
  try {
    for (const dir of readdirSync(winget)) {
      const exe = join(winget, dir, "bin", `${name}.exe`);
      if (existsSync(exe)) return exe;
    }
  } catch {
    /* fall through to PATH */
  }
  return name;
}

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
    // Actually play, with the keys the game listens for.
    //
    // The credit landing is the evidence the whole segment exists for: the
    // shop's server saw a private payment and unlocked something. A canvas
    // sitting still proves nothing, and the first take had exactly that,
    // because pressing START is not playing and nobody was at the keyboard.
    //
    // Real keydown and keyup on window, which is where the game listens, so the
    // movement on screen is the game's own physics responding to input. Held
    // for a beat each, the way a person holds a direction rather than tapping.
    async play(ms) {
      const keys = ["ArrowRight", "ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "ArrowLeft", "ArrowRight"];
      const press = (key, type) =>
        window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      const until = performance.now() + ms;
      let i = 0;
      while (performance.now() < until) {
        const key = keys[i++ % keys.length];
        press(key, "keydown");
        await new Promise((r) => setTimeout(r, 260 + (i % 3) * 90));
        press(key, "keyup");
        await new Promise((r) => setTimeout(r, 60));
      }
      return "played " + (ms / 1000).toFixed(1) + "s";
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
      // getBoundingClientRect answers in zoomed coordinates, and the ring's own
      // left and top are then zoomed again by the root zoom it lives under, so
      // at 1.4 the ring landed forty percent right and down of its target,
      // hanging half off the frame next to the thing it was meant to circle.
      // Divide once and the two cancel.
      const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      ring.style.left = ((r.left + scrollX) / z - pad) + "px";
      ring.style.top = ((r.top + scrollY) / z - pad) + "px";
      ring.style.width = (r.width / z + pad * 2) + "px";
      ring.style.height = (r.height / z + pad * 2) + "px";
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

const CHOREOGRAPHY = [
  {
    // The first five seconds used to be the GitHub file listing. A judge who
    // gives a video twenty seconds saw a repository page, scrolling. Now the
    // first frame is the product and the first sentence is its name: the shot
    // list opens on the thing itself and only reaches the landing page once
    // the viewer knows what they are looking at.
    id: "a",
    url: `${BASE}/apps/demo-arcade/index.html`,
    zoom: 1.4,
    steps: [
      // Top-aligned, not centred. The widget is taller than the screen, and
      // centring it put its middle in the middle: the header, the price and
      // half the button were above the fold while the narration said "this is
      // a payment box". The box has to enter head first.
      {
        at: 300,
        do: async (s) =>
          evaluate(
            s,
            `(() => { const r = document.querySelector(".spay").getBoundingClientRect();
               return window.__shoot.scrollTo(window.scrollY + r.top - 40, 700); })()`,
          ),
      },
      { at: 1200, do: async (s) => evaluate(s, `window.__shoot.spot(".spay", 12)`) },
      // 0:05 what it hides: the summary's HIDDEN line
      { at: 5000, do: async (s) => evaluate(s, `window.__shoot.spot(".spay-honesty-summary", 10)`) },
      // 0:09.5 the gap it fills
      { at: 8200, do: async (s) => evaluate(s, `window.__shoot.unspot()`) },
      { at: 8600, do: async (s, go) => go(`${BASE}/index.html`) },
      // 0:13.9 "So we did.", over the three cards
      { at: 13900, do: async (s) => evaluate(s, `window.__shoot.scrollTo(240, 1500)`) },
    ],
  },
  {
    id: "b",
    url: `${BASE}/apps/demo-arcade/index.html`,
    zoom: 1.4,
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
      //
      // Four seconds on the game, and not one more. It is the evidence that the
      // shop's server acted on a confirmed private payment, and evidence is all
      // it is: gameplay scores nothing here, and every second of it is a second
      // not spent on the three things that do score. It does have to move,
      // though. The first take pressed START and left the canvas sitting there,
      // which reads as a demo that froze.
      { at: 16800, do: async (s) => evaluate(s, `window.__shoot.scrollToEl("#screen", 900)`) },
      { at: 18000, do: async (s) => evaluate(s, `document.querySelector("#start")?.click()`) },
      { at: 18500, do: async (s) => evaluate(s, `window.__shoot.play(3300)`) },
      // 0:38 look at the price before you sign. A second coin, stopped before
      // paying, is what puts the confirmation block back on screen: the first
      // one has become a receipt and a receipt has no price on it.
      { at: 22000, do: async (s) => evaluate(s, `document.querySelector("#coin").click()`) },
      { at: 22400, do: async (s) => evaluate(s, `window.__shoot.scrollToEl(".spay-confirm", 1100)`) },
      // The frame under "look at the price" was mostly the dark canvas: the
      // scroll had centred the confirm rows but nothing told the eye where to
      // land. Ring them as soon as the scroll settles.
      { at: 23700, do: async (s) => evaluate(s, `window.__shoot.spot(".spay-confirm", 10)`) },
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
    url: `${BASE}/apps/dashboard/index.html`,
    zoom: 1.4,
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
      // 1:43 the QR encoder is ours. The navigation leaves a second earlier
      // than the narration needs it: GitHub takes a moment to paint, and the
      // frame under this line used to be its loading background.
      { at: 25400, do: async (s) => evaluate(s, `window.__shoot.unspot()`) },
      {
        at: 25800,
        do: async (s, go) =>
          go("https://github.com/bongbongcrypto/stealth-checkout/blob/main/packages/strk20-pay/src/qr.ts"),
      },
      { at: 29500, do: async (s) => evaluate(s, `window.__shoot.scrollTo(900, 2600)`) },
    ],
  },
  {
    id: "e",
    url: "https://github.com/bongbongcrypto/stealth-checkout/blob/main/strk20.json",
    zoom: 1.25,
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

/**
 * Choreography joined to the slot table, which owns every time in this file.
 *
 * The two used to each carry their own copy of from and to. That is the exact
 * shape of drift this project keeps finding: nothing warns you when the copies
 * disagree, and a recorder that thinks a segment is 34 seconds while the
 * assembler thinks it is 33 makes a video whose voice slides later at every cut.
 */
const SEGMENTS = SEGMENT_SLOTS.filter((slot) => CHOREOGRAPHY.some((c) => c.id === slot.id)).map((slot) => ({
  ...slot,
  ...CHOREOGRAPHY.find((c) => c.id === slot.id),
}));

/** Slots nobody can automate, listed so they are never quietly skipped. */
const OWNER_SEGMENTS = SEGMENT_SLOTS.filter((slot) => !CHOREOGRAPHY.some((c) => c.id === slot.id));

{
  const orphan = CHOREOGRAPHY.find((c) => !SEGMENT_SLOTS.some((s) => s.id === c.id));
  if (orphan) throw new Error(`there is choreography for segment ${orphan.id} and no slot for it`);
  const problems = checkSlots();
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

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

/**
 * Compare what the camera sees against what the page is, before recording.
 *
 * Everything that has gone wrong with this rig went wrong the same way: the
 * flags looked right, the script reported success, and the take came back with
 * something over it. A translate bubble in Korean. A leftover window showing
 * about:blank. The taskbar. None of that is in the DOM, so nothing the page can
 * be asked about would ever mention it.
 *
 * So the page is asked to draw itself, the screen is grabbed, and the two are
 * subtracted. Browser furniture only exists in one of them, and the difference
 * says so as a number. It catches the popup nobody has thought of yet, which is
 * the point: the next one will not be translate.
 */
async function cameraSeesThePage(s, region) {
  const shot = join(OUT, "preflight-page.png");
  const cam = join(OUT, "preflight-camera.png");
  const { data } = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(shot, Buffer.from(data, "base64"));

  execFileSync(findFfmpeg(), [
    "-y", "-loglevel", "error",
    "-f", "gdigrab", "-framerate", "2",
    "-offset_x", String(region.x), "-offset_y", String(region.y),
    "-video_size", `${region.w}x${region.h}`,
    "-i", "desktop", "-frames:v", "1", cam,
  ]);

  // Both are scaled to the same small size first: the page screenshot comes back
  // at the emulated resolution and the grab at the monitor's, and a difference
  // filter given two sizes fails rather than reporting one.
  // spawnSync, not execFileSync: ffmpeg prints filter metadata on stderr, and
  // execFileSync hands back stdout only, so the number was never there to read.
  const run = spawnSync(findFfmpeg(), [
    "-v", "info",
    "-i", shot, "-i", cam,
    "-filter_complex",
    "[0:v]scale=480:270,format=gray[a];[1:v]scale=480:270,format=gray[b];" +
      "[a][b]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f", "null", "-",
  ], { encoding: "utf8" });
  const match = /YAVG=([\d.]+)/.exec(`${run.stdout ?? ""}${run.stderr ?? ""}`);
  return match ? Number(match[1]) : null;
}

async function recordSegment(seg, { dry = false } = {}) {
  const length = secondsArg ?? seconds(seg.to) - seconds(seg.from);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `seg-${seg.id}.mp4`);

  console.log(`segment ${seg.id}: ${seg.what}`);
  console.log(`  ${seg.from} to ${seg.to} (${length.toFixed(1)}s)`);

  if (seg.needsWatcher) console.log(`  watcher: ${await ensureWatcher()}`);

  const mon = pickMonitor(monitorArg);
  if (!dry) {
    console.log(
      `  monitor ${mon.index}: ${mon.width}x${mon.height} at ${mon.x},${mon.y}` +
        (mon.primary ? "  (PRIMARY: this is the screen someone is using)" : ""),
    );
  }

  const browser = await launch({
    width: WIDTH,
    height: HEIGHT,
    x: mon.x,
    y: mon.y,
    port: 9222,
    headless: dry,
  });
  const s = browser.session;

  // Fullscreen on the chosen monitor, and film that whole monitor.
  //
  // The first attempt sized the window so its content was 1920x1080 and filmed
  // from window.screenX. Chrome reports the OUTER window there, not the content
  // box, so the take came back with the tab strip, the address bar and a
  // profile avatar across the top and the bottom of the page cut off. Rather
  // than guess at the height of browser furniture, there is now none: fullscreen
  // makes content and monitor the same rectangle, which is a fact rather than
  // an estimate. It also keeps the toolbar out of a video for a repository
  // whose whole point is that nobody knows who wrote it.
  let region = null;
  if (!dry) {
    const { windowId } = await s.send("Browser.getWindowForTarget");
    await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
    await sleep(800);

    // Give the page a 1920x1080 viewport, whatever the monitor is.
    //
    // A 2560-wide screen is not a bigger view of this page, it is a wider one:
    // the layout is capped, so the first take had the whole product in a column
    // down the middle with black either side. Overriding the metrics hands it
    // the viewport the design was built for, and Chrome paints that at 1:1 in
    // the top-left corner of the fullscreen window. Which is the good outcome:
    // the region is native 1080p, with no resampling anywhere in the chain.
    await s.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);

    const geo = await evaluate(s, `({iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio})`);
    region = { x: mon.x, y: mon.y, w: WIDTH, h: HEIGHT };
    if (geo.iw !== WIDTH || geo.ih !== HEIGHT) {
      console.log(`  note: the page laid out at ${geo.iw}x${geo.ih}, not ${WIDTH}x${HEIGHT}`);
    }
    console.log(`  filming ${region.w}x${region.h} at ${region.x},${region.y}, no scaling`);
  }

  /** Navigate and wait for the page to be usable, then re-inject the helpers. */
  const go = async (url) => {
    await s.send("Page.enable");
    const loaded = s.once("Page.loadEventFired", { timeout: 45000 });
    await s.send("Page.navigate", { url });
    await loaded;
    await sleep(900);
    await evaluate(s, HELPERS);
    // Everything on camera, larger. At 1920 wide the widget was 340px, 18% of
    // the frame, and the price inside it 26px: readable at a desk, gone on a
    // phone or a compressed stream. CSS zoom re-lays the page out, so it is a
    // real enlargement rather than scaled pixels, and 1.4 was measured to add
    // no sideways scroll on any screen this records.
    if (seg.zoom) {
      await evaluate(s, `document.documentElement.style.zoom = ${JSON.stringify(String(seg.zoom))}`);
      await sleep(300);
    }
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

    if (!dry) {
      // Retried, because some of what this catches goes away on its own. Chrome
      // puts up a "press and hold Esc to exit full screen" bubble across the top
      // of the window and takes it down a few seconds later; the first run of
      // this check found it sitting over the widget panel. A bubble fades and a
      // real problem does not, so the difference is measured until it settles.
      let diff = null;
      for (let i = 0; i < 12; i++) {
        diff = await cameraSeesThePage(s, region);
        if (diff !== null && diff <= 6) break;
        await sleep(1000);
      }
      if (diff === null) {
        console.log("  preflight: could not measure the screen against the page");
      } else if (diff > 6) {
        console.log(`  preflight: FAILED, the screen differs from the page by ${diff.toFixed(1)}/255`);
        console.log(`    something is drawn over the shot. Look at docs/recording/preflight-camera.png`);
        console.log(`    against preflight-page.png; whatever is in one and not the other is the problem.`);
        throw new Error("refusing to record a screen that is not the page");
      } else {
        console.log(`  preflight: the screen is the page (${diff.toFixed(1)}/255 apart)`);
      }
    }

    let capture = null;
    if (!dry) {
      capture = spawn(
        findFfmpeg(),
        [
          "-y", "-loglevel", "error",
          "-f", "gdigrab", "-framerate", "30",
          "-offset_x", String(region.x), "-offset_y", String(region.y),
          "-video_size", `${region.w}x${region.h}`,
          "-i", "desktop",
          "-t", String(length),
          // Only if the region is not already the output size. Scaling 1920x1080
          // to 1920x1080 still runs every pixel through a resampler.
          ...(region.w === WIDTH && region.h === HEIGHT
            ? []
            : ["-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos`]),
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
    // A shortened take runs only the choreography that lands inside it. Without
    // this a --seconds 12 proof still sat through the remaining forty seconds of
    // cues with the camera already off.
    const steps = secondsArg === null ? seg.steps : seg.steps.filter((x) => x.at <= secondsArg * 1000);
    for (const step of steps) {
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
      // ffmpeg stops itself at -t, which can happen before this line is reached.
      // Attaching an exit listener to a process that has already exited waits
      // for an event that will never come again, and two runs hung there with
      // the video already written to disk.
      if (capture.exitCode === null) {
        await Promise.race([
          new Promise((r) => capture.on("exit", r)),
          sleep(15000).then(() => capture.kill()),
        ]);
      }
      const probe = execFileSync(findFfmpeg("ffprobe"), [
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

monitorArg = arg("--monitor");
secondsArg = arg("--seconds") === null ? null : Number(arg("--seconds"));

if (argv.includes("--monitors")) {
  for (const m of monitors()) {
    console.log(
      `  ${m.index}  ${String(m.width).padStart(4)}x${String(m.height).padStart(4)} at ` +
        `${String(m.x).padStart(6)},${m.y}${m.primary ? "   PRIMARY" : ""}`,
    );
  }
  const chosen = pickMonitor(null);
  console.log(`\n  with no --monitor, the shoot goes to monitor ${chosen.index}`);
  process.exit(0);
}

if (argv.includes("--list") || argv.length === 0) {
  const { lines } = JSON.parse(readFileSync(join(ROOT, "docs", "demo-script.json"), "utf8"));
  const say = (from, to) =>
    lines.filter((l) => seconds(l.start) >= seconds(from) && seconds(l.start) < seconds(to)).length;
  for (const seg of [...SEGMENTS, ...OWNER_SEGMENTS].sort((a, b) => a.id.localeCompare(b.id))) {
    const auto = seg.steps ? "automatic" : "OWNER AT THE DESK";
    console.log(
      `  ${seg.id}  ${seg.from}-${seg.to}  ${String((seconds(seg.to) - seconds(seg.from)).toFixed(0)).padStart(2)}s  ` +
        `${String(say(seg.from, seg.to)).padStart(2)} lines  ${auto.padEnd(17)}  ${seg.what}`,
    );
  }
  const covered = [...SEGMENTS, ...OWNER_SEGMENTS].reduce((n, s) => n + seconds(s.to) - seconds(s.from), 0);
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
