#!/usr/bin/env node
// Check that the docs describe the code that exists.
//
//   node scripts/check-docs.mjs
//
// Written after a packed-tarball consume test happened to call `encodeQr` and
// found the integration guide describing a return shape the function does not
// have. That bug could not fail any test in this repo: the tests import from
// `src` and already know the shape, so only a reader following the prose would
// hit it, and the reader is a judge or another team.
//
// So the prose is checked the way the numbers are: against the thing itself.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const problems = [];
const checked = [];

const DOCS = ["README.md", "docs/INTEGRATION.md", "packages/strk20-pay/README.md", "index.html"];
const docText = Object.fromEntries(DOCS.map((f) => [f, read(f)]));
const allDocs = Object.values(docText).join("\n");

// ------------------------------------------------- npm scripts the docs cite
{
  const have = Object.keys(JSON.parse(read("package.json")).scripts);
  // The name charset must include digits: an earlier version of this pattern
  // stopped at the "2" of e2e:watcher and reported a script called "e".
  const cited = [...new Set([...allDocs.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]))];
  for (const name of cited) {
    if (!have.includes(name)) problems.push(`the docs tell a reader to run \`npm run ${name}\`, and package.json has no such script`);
  }
  checked.push(`npm scripts cited: ${cited.length}, all present`);
}

// ------------------------------------------------------- files the docs cite
{
  const cited = [...new Set([...allDocs.matchAll(/`((?:apps|docs|packages|scripts|server)\/[A-Za-z0-9._/-]+)`/g)].map((m) => m[1]))];
  let missing = 0;
  for (const path of cited) {
    // Trailing-slash directories and glob-ish mentions are not file claims.
    if (path.includes("*")) continue;
    // statSync, not readFileSync: half of what the docs cite are directories
    // (`apps/pay-live`, `server/watcher`), and reading a directory throws.
    try {
      statSync(join(ROOT, path.replace(/\/$/, "")));
    } catch {
      problems.push(`the docs point at \`${path}\`, which is not in the repository`);
      missing++;
    }
  }
  checked.push(`repo paths cited: ${cited.length}, missing ${missing}`);
}

// ------------------------------------------------ invoice states, both ways
//
// A merchant switches on `status`. A state the code can produce and the table
// does not list is one their code will not handle, and the table is the only
// place they can learn the set.
{
  // Both modules. The settled states are declared in lib.mjs and only ever
  // referenced from watcher.mjs, so reading the server alone reported `paid`,
  // `paid_late` and `expired` as documented-but-nonexistent: the three states
  // the whole product turns on.
  const watcher = read("server/watcher/watcher.mjs") + "\n" + read("server/watcher/lib.mjs");
  const table = read("docs/INTEGRATION.md");
  const documented = new Set(
    [...table.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]),
  );
  // `INVOICE_STATES` in lib.mjs is the declared set, so it is read rather than
  // inferred. Two earlier versions of this hunted for assignments instead and
  // were wrong in both directions: rows are replaced whole (`{ ...inv, status:
  // "cancelled" }`) so no assignment matched, and the settled states are
  // declared in one module and used from another.
  const decl = /export const INVOICE_STATES\s*=\s*\[([\s\S]*?)\];/.exec(watcher);
  if (!decl) {
    problems.push("lib.mjs no longer declares INVOICE_STATES, so the states table is unchecked");
  }
  const produced = new Set([...(decl?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  for (const s of produced) {
    if (!documented.has(s)) problems.push(`the watcher can set status \`${s}\`, and the states table does not list it`);
  }
  for (const s of documented) {
    if (!produced.has(s) && !watcher.includes(`"${s}"`)) {
      problems.push(`the states table documents \`${s}\`, and the watcher never sets it`);
    }
  }
  checked.push(`invoice states: ${produced.size} produced, ${documented.size} documented`);
}

// ------------------------------------------------ exports the package claims
//
// Read off the built entry points rather than the source, because the built
// files are what an installer gets.
{
  // Both entry points. `createCheckoutHook` lives on strk20-pay/react, and
  // reading only the main one reported the guide importing a name that does
  // not exist.
  const dist =
    read("packages/strk20-pay/dist/index.d.ts") + "\n" + read("packages/strk20-pay/dist/react.d.ts");
  const named = new Set([...dist.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]));
  // Only names the docs present as importable API: inside a backtick, and used
  // in an import or call position somewhere in the same document.
  const claimed = new Set();
  for (const text of Object.values(docText)) {
    for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']strk20-pay/g)) {
      for (const raw of m[1].split(",")) {
        const id = raw.trim().split(/\s+as\s+/)[0].trim();
        if (id) claimed.add(id);
      }
    }
  }
  const missing = [...claimed].filter((id) => !named.has(id));
  for (const id of missing) problems.push(`the docs import \`${id}\` from strk20-pay, and the built types do not export it`);
  checked.push(`names imported in doc examples: ${claimed.size}, all exported`);
}

// ------------------------------------------------------------------- report
for (const line of checked) console.log(`  ${line}`);
console.log();
if (problems.length === 0) {
  console.log("the docs describe the code that exists");
} else {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} claim${problems.length === 1 ? "" : "s"} the code does not back`);
  process.exit(1);
}
