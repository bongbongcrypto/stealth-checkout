#!/usr/bin/env node
// Capture one page for N seconds on the spare monitor, without touching the desk.
//
//   node scripts/capture-clip.mjs --url <url> --seconds <n> --out <file> [--eval <expression>]
//
// The segment recorder in record-demo.mjs is built around the narration's
// timeline. This is the loose end of the same rig, for the shots that are not
// a timed segment: the dashboard showing a row, a log rendered large. Same
// browser plumbing, same monitor, same native-1080p region, one page, fixed
// length.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { evaluate, launch } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const url = arg("--url");
const seconds = Number(arg("--seconds") ?? "8");
const out = arg("--out");
const expression = arg("--eval");
if (!url || !out) {
  console.error("need --url and --out");
  process.exit(1);
}

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
    /* PATH */
  }
  return "ffmpeg";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ x: 1920, y: 0, width: 1920, height: 1080, port: 9231 });
const s = browser.session;
try {
  await s.send("Page.enable");
  const { windowId } = await s.send("Browser.getWindowForTarget");
  await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  const loaded = s.once("Page.loadEventFired", { timeout: 45000 });
  await s.send("Page.navigate", { url });
  await loaded;
  await sleep(900);
  if (expression) {
    const got = await evaluate(s, expression);
    if (got !== undefined) console.log(`eval: ${String(got).slice(0, 100)}`);
  }
  // Let Chrome's fullscreen "press Esc" bubble fade before a frame is taken.
  await sleep(4500);

  const capture = spawn(
    findFfmpeg(),
    [
      "-y", "-loglevel", "error",
      "-f", "gdigrab", "-framerate", "30",
      "-offset_x", "1920", "-offset_y", "0",
      "-video_size", "1920x1080",
      "-i", "desktop",
      "-t", String(seconds),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      out,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await sleep(1200);
  // Reload so the page's own reveal animations start inside the capture
  // window. Only when asked: a reload also re-runs the page WITHOUT whatever
  // --eval set up, which for the dashboard meant the token vanished and ten
  // seconds of "watcher rejected the token" got recorded over an empty table.
  if (!argv.includes("--no-reload")) await evaluate(s, "location.reload()");
  await new Promise((r) => capture.on("exit", r));
  console.log(`wrote ${out} (${seconds}s)`);
} finally {
  await browser.close();
}
