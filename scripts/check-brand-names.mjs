#!/usr/bin/env node
// Stops a NEW use of the old upstream names (`omb`, `OMB_`, OpenMausBot, MausBot, milind-soni) in tracked files.
// Product text must say Seira.
//
// Two lists decide what passes:
//   ATTRIBUTION_PATHS   files that must keep the upstream name (Apache-2.0 notices). Never counted.
//   scripts/brand-names-baseline.json
//                       lines that still match today, per file: documented legacy fallbacks (env fallbacks, upgrade cleanup),
//                       their tests, and wire names that wait for the wire-name migration. A file may keep or lower its count.
//                       A file may not gain a match, and a file that is not listed may not have one.
//
//   node scripts/check-brand-names.mjs            check the tracked files
//   node scripts/check-brand-names.mjs --update   write the baseline (lower counts only; use it after you remove a match)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/brand-names-baseline.json";

/** The old name, without matching words such as "bomb" or "combo". */
export const OLD_NAME = /(?<![a-z0-9])omb(?![a-z0-9])|OMB_|openmausbot|mausbot|milind-soni/i;

/**
 * Lines that keep the old name on purpose, never counted (the documented "Keep" list):
 *  - the `.ombbackup` file extension, which restore must still accept;
 *  - links to upstream issues, pull requests and commits, and short owner/repo references (history, not product text);
 *  - the receive side of a wire name: reading `x-omb-*` from a header, so an old sender still works.
 */
export const KEEP_LINES = [
  /\.ombbackup/i,
  /milind-soni\/OpenMausBot\/(?:pull|issues|commit|compare)\b/i,
  /milind-soni\/OpenMausBot#\d+/i,
  /\bheaders\.get\(\s*["'`]x-omb-/i,
  /\bheaders\.get\([^)]*["'`]x-omb-[a-z-]+["'`]\s*\)/i,
];

/** Attribution that Apache-2.0 requires, and this guard itself. */
export const ATTRIBUTION_PATHS = new Set([
  "NOTICE", "LICENSING.md", "brand/README.md",
  "scripts/check-brand-names.mjs", "scripts/check-brand-names.test.ts", BASELINE,
]);

export function countMatches(files, read) {
  const counts = {};
  for (const path of files) {
    if (ATTRIBUTION_PATHS.has(path)) continue;
    let text;
    try { text = read(path); } catch { continue; }
    if (text.includes("\0")) continue;
    const n = text.split("\n").filter((line) => OLD_NAME.test(line) && !KEEP_LINES.some((keep) => keep.test(line))).length;
    if (n > 0) counts[path] = n;
  }
  return counts;
}

/** Problems: files whose count rose above the baseline, or that are new. */
export function compare(counts, baseline) {
  const problems = [];
  for (const [path, n] of Object.entries(counts)) {
    const allowed = baseline[path] ?? 0;
    if (n > allowed) problems.push({ path, found: n, allowed });
  }
  return problems;
}

export function lowered(counts, baseline) {
  return Object.keys(baseline).filter((path) => (counts[path] ?? 0) < baseline[path]);
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
  const counts = countMatches(files, (path) => readFileSync(join(root, path), "utf8"));
  if (process.argv.includes("--update")) {
    const old = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
    const next = {};
    for (const path of Object.keys(counts).sort()) next[path] = Math.min(counts[path], old[path] ?? counts[path]);
    writeFileSync(join(root, BASELINE), `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline written: ${Object.keys(next).length} files (counts only go down; new matches still fail)`);
    return;
  }
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
  const problems = compare(counts, baseline);
  if (problems.length) {
    console.error("New use of an old upstream name (omb, OMB_, OpenMausBot, MausBot, milind-soni):");
    for (const { path, found, allowed } of problems) console.error(`  ${path}: ${found} matching lines, ${allowed} allowed`);
    console.error("Use the Seira name. If this is a documented legacy fallback or attribution, say so in the PR and a reviewer adds it to scripts/brand-names-baseline.json.");
    process.exit(1);
  }
  const stale = lowered(counts, baseline);
  if (stale.length) console.log(`Note: ${stale.length} file(s) have fewer matches than the baseline. Run with --update to lock in the lower counts.`);
  console.log("ok: no new old-name matches");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
