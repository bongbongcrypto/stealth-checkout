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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // A port that something is already answering on is not a port to launch onto.
  //
  // A browser left over from an earlier run held 9222; the new one could not
  // bind it, /json/list returned the OLD browser's tabs, and the script spent a
  // full take driving a browser it could not see while the new window sat on
  // top of the shot showing about:blank. The recording came back as a picture
  // of that. So the port is probed first and a free one is taken.
  for (let tries = 0; tries < 20; tries++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
      port += 1; // answered, so it belongs to someone else
    } catch {
      break; // nothing there
    }
  }

  const profile = mkdtempSync(join(tmpdir(), "shoot-"));
  // Translate is switched off in the profile as well as on the command line.
  // The flag is one Chrome release away from being renamed, and the failure is
  // silent: a bubble appears over the corner of the shot and the take is only
  // wrong once it is watched back.
  try {
    mkdirSync(join(profile, "Default"), { recursive: true });
    writeFileSync(
      join(profile, "Default", "Preferences"),
      JSON.stringify({
        translate: { enabled: false },
        translate_blocked_languages: ["en", "ko"],
        intl: { accept_languages: "en-US,en", selected_languages: "en-US,en" },
        browser: { has_seen_welcome_page: true },
        profile: { exit_type: "Normal", exited_cleanly: true },
      }),
    );
  } catch {
    /* the flags are still in force; this is the belt to their braces */
  }

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
      "--hide-crash-restore-bubble",
      // The first take came back with a translate bubble over the top right
      // corner offering to turn the page Korean, in Korean, because that is the
      // language this machine's Chrome runs in. Two separate problems in one
      // popup: furniture on camera, and a very clear signal about who is holding
      // the mouse in a repository that is meant not to say. `Translate` alone
      // did not suppress it; the bubble is `TranslateUI`, and the interface
      // language has to be set as well or the next one arrives in Korean too.
      "--lang=en-US",
      "--accept-lang=en-US,en",
      "--disable-features=TranslateUI,Translate,MediaRouter",
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
    port,
    async close() {
      session.close();
      // Killing the process this spawned leaves the rest of Chrome behind: it
      // forks a renderer and a GPU process per tab and the launcher is not
      // their parent. Nine of them survived the first run and the script never
      // exited, so the whole tree goes, by pid, through Windows' own tool.
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        child.kill();
      }
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
