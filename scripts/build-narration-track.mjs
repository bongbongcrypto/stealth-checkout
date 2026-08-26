#!/usr/bin/env node
// Lay the per-line narration onto one three minute track, each line starting at
// the time the script gives it.
//
//   node scripts/build-narration-track.mjs
//
// Placing each line at its own start time rather than concatenating them is the
// whole point: the shot list and the captions are keyed to those timestamps, so
// a track built by butting the clips together would drift out of sync with both
// by the end, and there would be no way to fix one sentence without recutting
// every sentence after it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NARRATION = join(ROOT, "docs", "narration");
const OUT = join(ROOT, "docs", "demo.narration.wav");

/** ffmpeg is not on PATH in every shell here, so it is looked up rather than assumed. */
function findFfmpeg(name) {
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
const FFMPEG = findFfmpeg("ffmpeg");
const FFPROBE = findFfmpeg("ffprobe");

const seconds = (stamp) => {
  const m = /^(\d{1,2}):(\d{2})\.(\d{3})$/.exec(stamp);
  if (!m) throw new Error(`not a mm:ss.mmm timestamp: ${stamp}`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
};

const { lines } = JSON.parse(readFileSync(join(ROOT, "docs", "demo-script.json"), "utf8"));
const total = seconds(lines.at(-1).end);

const clips = lines.map((line, i) => {
  const file = join(NARRATION, `${String(i + 1).padStart(2, "0")}.mp3`);
  if (!existsSync(file)) {
    console.error(`missing ${file}. Run scripts/make-narration.sh first.`);
    process.exit(1);
  }
  const duration = Number(
    execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
      .toString()
      .trim(),
  );
  return { file, start: seconds(line.start), end: seconds(line.end), duration, say: line.say };
});

// A line longer than its slot would talk over the next one. The script's own
// generator already guards the words-per-minute estimate; this checks the audio
// that actually came back, which is the thing that will be in the video.
const overruns = clips.filter((c) => c.duration > c.end - c.start + 0.05);
if (overruns.length > 0) {
  for (const c of overruns) {
    console.error(
      `"${c.say.slice(0, 46)}" runs ${c.duration.toFixed(2)}s in a ${(c.end - c.start).toFixed(2)}s slot`,
    );
  }
  console.error(`${overruns.length} line(s) overrun their slot; shorten them in demo-script.json`);
  process.exit(1);
}

// One silent bed of the full length, then each line delayed to its start time
// and mixed in. `adelay` takes milliseconds, per channel.
const inputs = ["-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=stereo"];
for (const c of clips) inputs.push("-i", c.file);

const filters = clips.map(
  (c, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(c.start * 1000)}|${Math.round(c.start * 1000)}[a${i}]`,
);
const mixInputs = ["[0:a]", ...clips.map((_, i) => `[a${i}]`)].join("");
// `normalize=0` keeps each line at the level the voice produced. amix normalises
// by input count by default, which with thirty inputs would drop the narration
// to a whisper.
filters.push(`${mixInputs}amix=inputs=${clips.length + 1}:duration=first:normalize=0[out]`);

execFileSync(
  FFMPEG,
  [
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-t",
    String(total),
    "-c:a",
    "pcm_s16le",
    OUT,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const built = Number(
  execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT])
    .toString()
    .trim(),
);
if (Math.abs(built - total) > 0.5) {
  console.error(`the track came out ${built.toFixed(1)}s, expected ${total.toFixed(1)}s`);
  process.exit(1);
}

const speech = clips.reduce((n, c) => n + c.duration, 0);
console.log(`wrote docs/demo.narration.wav`);
console.log(`  ${clips.length} lines, ${built.toFixed(1)}s total, ${speech.toFixed(1)}s of speech`);
console.log(`  ${(100 - (speech / built) * 100).toFixed(0)}% of the track is room for the screen to work`);
