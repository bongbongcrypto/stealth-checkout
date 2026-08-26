// A small Chrome DevTools Protocol client, so the demo can be recorded without
// anyone touching the mouse.
//
// Why this instead of synthesising mouse and keyboard input: driving the screen
// with real input means owning the whole machine for the length of the shoot,
// and one stray click ruins the take. CDP talks to the browser over a socket,
// so the page scrolls and clicks while the window sits there unfocused and the
// person at the desk carries on with another monitor.
//
// Nothing is installed for this. Node 24 ships WebSocket and fetch, and the
// protocol is the browser's own, which is what keeps this inside the rule about
// not running unvetted code on the machine that holds the keys.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

export function findBrowser() {
  const found = BROWSERS.find((p) => existsSync(p));
  if (!found) throw new Error("no Chrome or Edge on this machine");
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a browser with a throwaway profile and a debugging port.
 *
 * The profile is a fresh temporary directory every time, which is the point:
 * the everyday profile on this machine carries bookmarks, history, logged-in
 * accounts and a hundred wallet extensions, and any of those on camera would
 * undo the repository's pseudonymity in a single frame.
 */
export async function launch({
  port = 9222,
  width = 1920,
  height = 1080,
  x = 0,
  y = 0,
  headless = false,
  fullscreen = false,
} = {}) {
  const profile = mkdtempSync(join(tmpdir(), "shoot-"));
  const child = spawn(
    findBrowser(),
    [
      // Headless is for proving the rig works without a window appearing on
      // someone's desk. Nothing is ever recorded this way: gdigrab captures
      // pixels, and headless has none.
      ...(headless ? ["--headless=new", `--window-size=${width},${height}`] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-position=${x},${y}`,
      `--window-size=${width},${height}`,
      // Fullscreen because the taskbar draws over any window that tries to own
      // the bottom of the screen, and a captured region that stops above it is
      // not 16:9. It also keeps the address bar, the tab strip and whatever a
      // profile has pinned to it out of a video for a pseudonymous repository.
      ...(fullscreen ? ["--start-fullscreen"] : []),
      // A window nobody is looking at is a window Chrome stops drawing. All
      // three of these keep it rendering at full rate while it sits in the
      // background, which is the whole reason the desk stays usable.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      // Chrome's own furniture, on camera, in a video about a payment page.
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      "--hide-crash-restore-bubble",
      "about:blank",
    ],
    { detached: false, stdio: "ignore" },
  );

  // The port is not open the instant the process is, so it is polled rather
  // than slept at: a fixed wait is either too short on a cold start or wasted
  // on a warm one.
  let targets = null;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  if (!targets) throw new Error(`the browser never opened a debugging port on ${port}`);

  const page = targets.find((t) => t.type === "page");
  const session = await connect(page.webSocketDebuggerUrl);

  return {
    session,
    async close() {
      session.close();
      child.kill();
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold a lock; a temp dir is not worth failing over */
      }
    },
  };
}

/** One CDP connection: send a command, await its reply; subscribe to events. */
export async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      // A protocol error is a real error. Returning it as a value meant a
      // failed selector looked exactly like a successful no-op.
      if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`));
      else slot.resolve(msg.result);
      return;
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    once(method, { timeout = 30000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waited ${timeout}ms for ${method}`)), timeout);
        this.on(method, (params) => {
          clearTimeout(timer);
          resolve(params);
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

/** Evaluate an expression in the page and return its value. */
export async function evaluate(session, expression) {
  const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}
