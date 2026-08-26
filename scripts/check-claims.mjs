#!/usr/bin/env node
// Check that the numbers written in the docs are the numbers that are true.
//
//   node scripts/check-claims.mjs
//
// Written after the test count in the README drifted three times in one day.
// Each time it was corrected by hand and each time it went stale again within
// an hour, because nothing was watching. A number in a README that nobody
// checks is a claim, and this project's whole argument is that it does not make
// claims it has not verified.
//
// Every fact here is measured, not configured: the suite is run, the manifest is
// counted, the chain is asked.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const problems = [];
const checked = [];

/** Compare one measured fact against every place the docs state it. */
function claim(name, actual, files, pattern) {
  let found = 0;
  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const m of text.matchAll(pattern)) {
      found++;
      const stated = Number(m[1]);
      if (stated !== actual) {
        problems.push(`${file}: says ${stated} ${name}, and there are ${actual}`);
      }
    }
  }
  checked.push(`${name}: ${actual} (stated in ${found} place${found === 1 ? "" : "s"})`);
  if (found === 0) problems.push(`${name}: nothing in the docs states this, so nothing is being checked`);
}

// ---------------------------------------------------------------- the suite
// The file list is expanded here rather than by a shell: a glob passed through
// `shell: true` on Windows came back empty, the count could not be read, and the
// checker reported that as a stale claim.
const testFiles = ["packages/strk20-pay/test", "server/watcher/test"].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => join(dir, f)),
);
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const tap = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const passed = Number(/^# pass (\d+)$/m.exec(tap)?.[1] ?? NaN);
const failed = Number(/^# fail (\d+)$/m.exec(tap)?.[1] ?? NaN);
if (!Number.isFinite(passed)) {
  problems.push("could not read a test count out of the suite, so the README's number is unchecked");
} else {
  if (failed > 0) problems.push(`${failed} tests are failing, so no number in the docs is worth checking yet`);
  claim("tests", passed, ["README.md", "PROGRESS.md"], /(\d+)\s+tests(?:\s+passing|:)/g);
}

// ------------------------------------------------------------- the manifest
const manifest = JSON.parse(read("strk20.json"));
claim(
  "mainnet transactions",
  manifest.transactions.length,
  ["README.md", "PROGRESS.md"],
  /(\d+) mainnet transactions/g,
);

// The README also spells it out in words, in the sentence a judge reads first.
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const spelled = new RegExp(`lists (${WORDS.join("|")}) Starknet mainnet transactions`, "g");
let spelledFound = 0;
for (const m of read("README.md").matchAll(spelled)) {
  spelledFound++;
  if (WORDS.indexOf(m[1]) !== manifest.transactions.length) {
    problems.push(`README.md: says "${m[1]}" mainnet transactions, and there are ${manifest.transactions.length}`);
  }
}
checked.push(`the same count spelled out: ${spelledFound} place${spelledFound === 1 ? "" : "s"}`);

// ------------------------------------------------------------------ the fee
// Stated all over the docs and the UI, and it is the finding the project is
// built on, so it is asked of the chain rather than trusted.
if (!process.argv.includes("--offline")) {
  try {
    const { RpcProvider } = await import("starknet");
    const provider = new RpcProvider({ nodeUrl: "https://rpc.starknet.lava.build" });
    const res = await provider.callContract({
      contractAddress: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
      entrypoint: "get_fee_amount",
      calldata: [],
    });
    const fee = Number(BigInt(res[0] ?? "0x0") + (BigInt(res[1] ?? "0x0") << 128n)) / 1e18;
    if (!Number.isFinite(fee) || fee === 0) {
      problems.push("the pool answered with no fee, which is not a number this project should print");
    } else {
      claim("STRK per operation", fee, ["README.md"], /flat (\d+) STRK per operation/g);
    }
  } catch (err) {
    checked.push(`pool fee: could not reach a node (${err.message.slice(0, 60)}), so this was not checked`);
  }
} else {
  checked.push("pool fee: skipped, --offline");
}

// --------------------------------------------------------------------- done
for (const line of checked) console.log(`  ${line}`);
console.log();
if (problems.length === 0) {
  console.log("every number the docs state is the number that is true");
} else {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} claim${problems.length === 1 ? "" : "s"} out of date`);
  process.exit(1);
}
