#!/usr/bin/env node
// Build every video asset from docs/demo-script.json.
//
//   node scripts/make-video-assets.mjs           write the files
//   node scripts/make-video-assets.mjs --check   validate only
//
// Out:
//   docs/demo.narration.txt  the text to hand a TTS voice, one line per cue
//   docs/demo.short.ass      short-form captions: a few words at a time, big,
//                            outlined, with a small bounce as each one lands
//   docs/demo.en.srt         the same words as ordinary full-line subtitles
//   docs/demo.ko.srt         the Korean gloss, for whoever is editing
//   the shot table inside docs/VIDEO-SCRIPT.md
//
// One source, because two hand-kept copies of the same script had already
// started to disagree about what the video says.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "docs", "demo-script.json");

/** Words per minute a synthetic voice reads at, near enough for planning. */
const SPEAKING_RATE = 155;
/** Above this a line will not fit its slot and the voice will run into the next. */
const MAX_RATE = 185;
/** Words per caption. Short-form captions land in bursts, not paragraphs. */
const WORDS_PER_POP = 4;

const parseTime = (text) => {
  const m = /^(\d{1,2}):(\d{2})\.(\d{3})$/.exec(text);
  if (!m) throw new Error(`not a mm:ss.mmm timestamp: ${text}`);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]);
};

const srtTime = (ms) =>
  `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:` +
  `${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:` +
  `${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},` +
  `${String(ms % 1000).padStart(3, "0")}`;

/** ASS wants h:mm:ss.cc, with centiseconds and no leading zero on the hour. */
const assTime = (ms) =>
  `${Math.floor(ms / 3600000)}:` +
  `${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:` +
  `${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.` +
  `${String(Math.floor((ms % 1000) / 10)).padStart(2, "0")}`;

/** ffprobe, wherever winget put it, else whatever is on PATH. */
const FFPROBE = (() => {
  const winget = join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
  );
  try {
    for (const dir of readdirSync(winget)) {
      const exe = join(winget, dir, "bin", "ffprobe.exe");
      if (existsSync(exe)) return exe;
    }
  } catch {
    /* fall through to PATH */
  }
  return "ffprobe";
})();

const { lines } = JSON.parse(readFileSync(SOURCE, "utf8"));
const problems = [];

/**
 * How long each line actually takes to say, read off the synthesised audio.
 *
 * Captions used to be spread across the whole slot a line occupies. A slot is
 * longer than its sentence on purpose, so that the screen has room to work, and
 * the effect was that the last words of a caption sat there for up to 2.7
 * seconds after the voice had stopped saying them. Measured against the audio,
 * a caption ends when the sentence ends.
 *
 * Before the audio exists there is nothing to measure, so the words-per-minute
 * estimate stands in and says so. That case is the first run only.
 */
function spokenLengths() {
  const dir = join(ROOT, "docs", "narration");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const file = join(dir, `${String(i + 1).padStart(2, "0")}.mp3`);
    if (!existsSync(file)) return null;
    const probe = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
      encoding: "utf8",
    });
    const seconds = Number((probe.stdout ?? "").trim());
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    out.push(seconds * 1000);
  }
  return out;
}

const spoken = spokenLengths();
if (spoken === null) {
  console.log("no narration audio yet, so captions are timed from the words-per-minute estimate");
}

let previousEnd = -1;
lines.forEach((line, i) => {
  const n = i + 1;
  const start = parseTime(line.start);
  const end = parseTime(line.end);
  if (end <= start) problems.push(`line ${n}: ends at or before it starts`);
  if (start < previousEnd) problems.push(`line ${n}: starts before line ${i} ended`);
  previousEnd = end;

  if (!line.say) problems.push(`line ${n}: nothing to say`);
  if (!line.ko) problems.push(`line ${n}: no Korean gloss`);
  if (!line.shot) problems.push(`line ${n}: no shot`);

  const seconds = (end - start) / 1000;
  const words = (line.say ?? "").trim().split(/\s+/).filter(Boolean).length;
  const rate = (words / seconds) * 60;
  if (rate > MAX_RATE) {
    problems.push(
      `line ${n}: ${words} words in ${seconds.toFixed(1)}s is ${rate.toFixed(0)} wpm, ` +
        `over ${MAX_RATE}. Needs ${((words / MAX_RATE) * 60).toFixed(1)}s, or fewer words.`,
    );
  }
  // Dead air. A voice that finishes four seconds early leaves the viewer
  // watching a still frame wondering whether the video broke.
  const silence = seconds - (words / SPEAKING_RATE) * 60;
  if (silence > 3.5 && n !== lines.length) {
    problems.push(`line ${n}: ${silence.toFixed(1)}s of silence after the voice finishes`);
  }

  // An em dash is banned in this project's writing, and a voice reads it as a
  // pause it was never told about.
  if (/[—–]/.test(line.say ?? "")) problems.push(`line ${n}: contains a dash a voice cannot read`);
});

for (const problem of problems) console.error(problem);

const total = parseTime(lines.at(-1).end);
const allWords = lines.reduce((n, l) => n + l.say.trim().split(/\s+/).length, 0);
console.log(
  `${lines.length} lines, ${allWords} words, ${(total / 1000).toFixed(1)}s, ` +
    `${((allWords / (total / 1000)) * 60).toFixed(0)} wpm average, ${problems.length} problems`,
);
if (total > 185_000) console.error(`the brief says three minutes; this runs ${(total / 1000).toFixed(0)}s`);
if (problems.length > 0) {
  console.error("nothing written");
  process.exit(1);
}

/**
 * Split a spoken line into short caption bursts, evenly.
 *
 * Slicing four words at a time leaves whatever is left over alone in the last
 * burst, so a thirteen-word line ended "...into any page." / "page." and that
 * single word flashed for a fifth of a second. Three lines of the original
 * script did it, and the half-second floor below missed all three by eight
 * milliseconds.
 *
 * So the burst count is fixed first, and the words are spread across it: the
 * remainder rides in the early bursts, where there is company, instead of
 * being stranded at the end.
 */
function pops(text) {
  const words = text.trim().split(/\s+/);
  const count = Math.ceil(words.length / WORDS_PER_POP);
  const out = [];
  let i = 0;
  for (let c = 0; c < count; c++) {
    const take = Math.ceil((words.length - i) / (count - c));
    out.push(words.slice(i, i + take).join(" "));
    i += take;
  }
  return out;
}

/**
 * @param {boolean} korean add the Korean gloss under each English burst.
 *
 * Two files come out of this. The one that gets submitted carries English only,
 * because that is the video the judges watch. The review copy carries the gloss
 * underneath, so the person whose name is on the entry can read what it says
 * about their project before it goes out. Nobody should have to submit a video
 * in a language they cannot check.
 */
function buildAss(korean = false) {
  const head = [
    "[Script Info]",
    "; Short-form captions for the Stealth Checkout demo.",
    "; Generated by scripts/make-video-assets.mjs. Do not edit by hand.",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour," +
      " Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline," +
      " Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // White fill, heavy black outline, sitting just above the lower third, which
    // is where a phone's UI is not.
    "Style: Pop,Arial Black,96,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,4,2,140,140,150,1",
    // The gloss: smaller, calmer, and low enough to sit clear of the 96px burst
    // above it. Malgun Gothic because this is Windows and it is the system's
    // Korean face; a font that cannot draw Hangul draws boxes, which is worse
    // than no gloss at all, so the built file is checked against a rendered
    // frame rather than trusted.
    ...(korean
      // BorderStyle 3 draws a filled box behind the text rather than an outline
      // around it, and with BorderStyle 3 the box takes OutlineColour. Plain
      // outlined text sat straight on top of a README and the two read as one
      // paragraph; a band underneath makes the gloss obviously a caption and
      // obviously not part of the product.
      ? ["Style: Ko,Malgun Gothic,42,&H00DCEEFF,&H000000FF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,10,0,2,90,90,52,129"]
      : []),
    "",
    "[Events]",
    // MarginV MUST be here. The Dialogue lines below emit three margin values
    // (0,0,0); a Format that names only two makes libass read the third as
    // Effect and fold the comma that follows into the caption text, so every
    // burst rendered with a leading comma: ",Starknet can hide who".
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = [];
  lines.forEach((line, index) => {
    const start = parseTime(line.start);
    const slotEnd = parseTime(line.end);
    // The caption tracks the sentence, not the slot. A small tail is added so
    // the last burst does not vanish on the syllable it ends with, and it is
    // never allowed past the slot, or two lines would be on screen at once.
    const spokenFor = spoken ? spoken[index] : ((line.say.trim().split(/\s+/).length / SPEAKING_RATE) * 60000);
    const end = Math.min(slotEnd, start + spokenFor + 350);
    const chunks = pops(line.say);
    // Share the slot out by length, so a long burst is not on screen as briefly
    // as a two-word one.
    const weights = chunks.map((c) => c.length);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let at = start;
    chunks.forEach((chunk, i) => {
      const span = Math.round(((end - start) * weights[i]) / totalWeight);
      const to = i === chunks.length - 1 ? end : at + span;
      // Fade in fast, and overshoot the scale for two frames so each burst lands
      // rather than appearing.
      const effect = "{\\fad(50,50)\\t(0,90,\\fscx112\\fscy112)\\t(90,190,\\fscx100\\fscy100)}";
      const text = chunk.replace(/\{/g, "(").replace(/\}/g, ")");
      // 0,time,time,Pop,,0,0,0,, = Layer, Start, End, Style, Name, MarginL,
      // MarginR, MarginV, Effect(empty), then Text. Nine fields, matching the
      // nine names before Text in the Format line above. Drop MarginV from
      // either side and libass reads a comma into the text.
      events.push(`Dialogue: 0,${assTime(at)},${assTime(to)},Pop,,0,0,0,,${effect}${text}`);
      at = to;
    });

    // One gloss for the whole line, held for as long as the line is spoken,
    // rather than chopped to match the bursts above it. The bursts are paced for
    // the ear; a sentence in another language is read once.
    if (korean && line.ko) {
      const gloss = line.ko.replace(/\{/g, "(").replace(/\}/g, ")");
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Ko,,0,0,0,,{\\fad(120,120)}${gloss}`);
    }
  });

  // The header and the Dialogue lines must agree on how many fields precede the
  // text, or a comma folds into every caption. This was shipped once, invisible
  // until the .ass was rendered, so it is asserted rather than trusted.
  const eventsFormat = head.find((l) => l.startsWith("Format: Layer"));
  const namesBeforeText = eventsFormat.replace("Format:", "").split(",").length - 1; // minus Text
  const fieldsBeforeText = "0,0:00:00.00,0:00:00.50,Pop,,0,0,0,".split(",").length; // a sample Dialogue prefix
  if (namesBeforeText !== fieldsBeforeText) {
    console.error(
      `the ASS Events Format names ${namesBeforeText} fields before Text, but each Dialogue emits ` +
        `${fieldsBeforeText}; the mismatch folds a comma into every caption`,
    );
    process.exit(1);
  }
  // A burst nobody can read is worse than none, so this is checked rather than
  // assumed. Half a second is about the floor for taking in three words.
  const ms = (t) => {
    const [h, m, rest] = t.trim().split(":");
    const [sec, cs] = rest.split(".");
    return ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000 + Number(cs) * 10;
  };
  const tooFast = events.filter((e) => {
    const f = e.slice("Dialogue:".length).split(",");
    return ms(f[2]) - ms(f[1]) < 500;
  });
  if (tooFast.length > 0) {
    console.error(`${tooFast.length} captions are on screen for under half a second`);
    process.exit(1);
  }
  // A lone word between two full bursts reads as a glitch even when it is on
  // screen long enough to read, so it is caught by shape and not only by
  // duration. Single-burst lines ("Drop a coin in.") are not orphans.
  for (const line of lines) {
    const chunks = pops(line.say);
    if (chunks.length < 2) continue;
    const orphan = chunks.findIndex((c) => c.trim().split(/\s+/).length < 2);
    if (orphan !== -1) {
      console.error(`"${line.say}" leaves "${chunks[orphan]}" alone in a caption`);
      process.exit(1);
    }
  }

  return [...head, ...events].join("\n") + "\n";
}

if (!process.argv.includes("--check")) {
  const write = (name, body) => {
    writeFileSync(join(ROOT, "docs", name), body, "utf8");
    console.log(`wrote docs/${name}`);
  };

  // One sentence per line, so a voice pauses where the script pauses and the
  // audio lines up with the cues without hand-trimming.
  write("demo.narration.txt", lines.map((l) => l.say).join("\n") + "\n");

  // The sidecar tracks end when the sentence ends too, for the same reason the
  // burned ones do: a subtitle still up two seconds after the voice moved on
  // reads as a video that is out of sync, whichever track it is on.
  const srtEnd = (line, i) => {
    const start = parseTime(line.start);
    const spokenFor = spoken ? spoken[i] : ((line.say.trim().split(/\s+/).length / SPEAKING_RATE) * 60000);
    return Math.min(parseTime(line.end), start + spokenFor + 350);
  };
  for (const [name, key] of [["demo.en.srt", "say"], ["demo.ko.srt", "ko"]]) {
    write(
      name,
      lines
        .map((l, i) => `${i + 1}\n${srtTime(parseTime(l.start))} --> ${srtTime(Math.round(srtEnd(l, i)))}\n${l[key]}\n`)
        .join("\n"),
    );
  }

  write("demo.short.ass", buildAss());
  write("demo.review.ass", buildAss(true));

  const doc = join(ROOT, "docs", "VIDEO-SCRIPT.md");
  const text = readFileSync(doc, "utf8");
  const START = "<!-- shots:start -->";
  const END = "<!-- shots:end -->";
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  if (from === -1 || to === -1) {
    console.error(`VIDEO-SCRIPT.md has no ${START} / ${END} markers; table not written`);
  } else {
    const rows = lines.map((l) => {
      const ms = parseTime(l.start);
      const clock = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
      const esc = (s) => s.replace(/\|/g, "\\|");
      return `| ${clock} | ${esc(l.shot)} | ${esc(l.say)} |`;
    });
    const table = [START, "", "| Time | On screen | Narration |", "| --- | --- | --- |", ...rows, "", END].join(
      "\n",
    );
    writeFileSync(doc, text.slice(0, from) + table + text.slice(to + END.length), "utf8");
    console.log("rewrote the shot table in docs/VIDEO-SCRIPT.md");
  }
}
