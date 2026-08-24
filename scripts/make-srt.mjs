#!/usr/bin/env node
// Build the demo video's subtitle files from docs/demo-subtitles.json.
//
//   node scripts/make-srt.mjs          write the files, fail on a problem
//   node scripts/make-srt.mjs --check   report only, write nothing
//
// Two languages come out of one source so their timings cannot drift apart, and
// so the person editing can see, line for line, what the English says.
//
// It refuses to write a file that asks a viewer to read faster than they can.
// A subtitle nobody finishes reading is worse than no subtitle: it takes the
// viewer's attention and gives nothing back.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "docs", "demo-subtitles.json");

/**
 * Reading-speed ceilings, in characters per second.
 *
 * These are the broadcast conventions: about 17 for Latin script, and a lower
 * number for Korean because each syllable block carries more.
 */
const LIMITS = {
  en: { cps: 17, lineChars: 42, lines: 2 },
  ko: { cps: 12, lineChars: 24, lines: 2 },
};

/** `mm:ss.mmm` to milliseconds. */
function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})\.(\d{3})$/.exec(text);
  if (!m) throw new Error(`not a mm:ss.mmm timestamp: ${text}`);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]);
}

/** Milliseconds to SRT's `hh:mm:ss,mmm`. */
function srtTime(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
}

const { cues } = JSON.parse(readFileSync(SOURCE, "utf8"));
const problems = [];

let previousEnd = -1;
cues.forEach((cue, i) => {
  const n = i + 1;
  const start = parseTime(cue.start);
  const end = parseTime(cue.end);
  if (end <= start) problems.push(`cue ${n}: ends at or before it starts`);
  if (start < previousEnd) problems.push(`cue ${n}: starts before cue ${i} ended`);
  previousEnd = end;

  const seconds = (end - start) / 1000;
  if (seconds < 1.2) problems.push(`cue ${n}: ${seconds}s is too short to read at all`);

  for (const [lang, limit] of Object.entries(LIMITS)) {
    const text = cue[lang];
    if (!text) {
      problems.push(`cue ${n}: no ${lang} text`);
      continue;
    }
    const lines = text.split("\n");
    if (lines.length > limit.lines) {
      problems.push(`cue ${n} ${lang}: ${lines.length} lines, ${limit.lines} is the most that fits`);
    }
    lines.forEach((line, li) => {
      if (line.length > limit.lineChars) {
        problems.push(
          `cue ${n} ${lang} line ${li + 1}: ${line.length} characters, over ${limit.lineChars}`,
        );
      }
    });
    // Spaces and newlines are not read, so they do not count against the budget.
    const readable = text.replace(/\s/g, "").length;
    const cps = readable / seconds;
    if (cps > limit.cps) {
      problems.push(
        `cue ${n} ${lang}: ${cps.toFixed(1)} characters per second, over ${limit.cps} ` +
          `(needs ${(readable / limit.cps).toFixed(1)}s, has ${seconds.toFixed(1)}s)`,
      );
    }
  }
});

for (const problem of problems) console.error(problem);

const total = parseTime(cues.at(-1).end);
console.log(
  `${cues.length} cues, ${(total / 1000).toFixed(1)}s total, ${problems.length} problems`,
);
if (total > 185_000) console.error(`the brief says three minutes; this runs ${(total / 1000).toFixed(0)}s`);

if (problems.length > 0) {
  console.error("nothing written");
  process.exit(1);
}

if (!process.argv.includes("--check")) {
  for (const lang of Object.keys(LIMITS)) {
    const body = cues
      .map((cue, i) => `${i + 1}\n${srtTime(parseTime(cue.start))} --> ${srtTime(parseTime(cue.end))}\n${cue[lang]}\n`)
      .join("\n");
    const out = join(ROOT, "docs", `demo.${lang}.srt`);
    // No BOM: some editors show it as a stray character on the first cue.
    writeFileSync(out, body, "utf8");
    console.log(`wrote docs/demo.${lang}.srt`);
  }
}
