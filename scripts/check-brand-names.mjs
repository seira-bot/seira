#!/usr/bin/env node
// Stops a NEW use of the old upstream names (`omb`, `OMB_`, OpenMausBot, MausBot, milind-soni) in tracked files.
// Product text must say Seira.
//
// Two lists decide what passes:
//   ATTRIBUTION_PATHS   files that must keep the upstream name (Apache-2.0 notices). Never counted.
//   scripts/brand-names-baseline.json
//                       a short hash of each reviewed line that still matches today, per file: documented legacy
//                       fallbacks, their tests, and wire names that wait for the wire-name migration. The file holds
//                       no line text, so no fixture path or sample value is copied into the repo. A line may not
//                       appear more often than listed, and a line that is not listed fails, even if another line
//                       was removed. The failure message prints the line from your own checkout so you can find it.
//
//   node scripts/check-brand-names.mjs            check the tracked files
//   node scripts/check-brand-names.mjs --update   remove baseline entries that are gone. It never adds a path, a line or a repeat.
//   node scripts/check-brand-names.mjs --hash '<line>'   print the baseline hash of one line
//   node scripts/check-brand-names.mjs --init     create the baseline when it does not exist
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/brand-names-baseline.json";

/** The old name, without matching words such as "bomb" or "combo". */
export const OLD_NAME = /(?<![a-z0-9])omb(?![a-z0-9])|OMB_|openmausbot|mausbot|milind-soni/i;

/** Attribution that Apache-2.0 requires, and this guard itself. */
export const ATTRIBUTION_PATHS = new Set([
  "NOTICE", "LICENSING.md", "brand/README.md",
  "scripts/check-brand-names.mjs", "scripts/check-brand-names.test.ts", BASELINE,
]);

/**
 * Tokens that keep the old name on purpose (the documented "Keep" list). Only the matching token is removed;
 * the rest of the line is still checked, so a new old-name on the same line fails.
 *  - the `.ombbackup` file extension, which restore must still accept;
 *  - links to upstream issues, pull requests and commits, and short owner/repo references (history, not product text);
 *  - the receive side of a wire name: reading one `x-omb-*` header with `headers.get("...")`.
 */
export const KEEP_TOKENS = [
  /\.ombbackup\b/gi,
  /https?:\/\/github\.com\/milind-soni\/OpenMausBot\/(?:pull|issues|commit|compare)\/[^\s)"'`>\]]*/gi,
  /milind-soni\/OpenMausBot#\d+/gi,
  /\bheaders\.get\(\s*["'`]x-omb-[a-z0-9-]+["'`]\s*\)/gi,
];

/** The line without its kept tokens. */
export const withoutKept = (line) => KEEP_TOKENS.reduce((rest, keep) => rest.replace(keep, " "), line);

/** A line in the baseline: the first 16 hex characters of sha256 over the line. Only the ends are trimmed: spaces inside the line count, so two strings that differ in inner spaces are two lines. */
export const lineHash = (line) => createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);

/** Offending lines per file, as text, with repeats. Used for the failure message only. */
export function findLines(files, read) {
  const found = {};
  for (const path of files) {
    if (ATTRIBUTION_PATHS.has(path)) continue;
    let text;
    try { text = read(path); } catch { continue; }
    if (text.includes("\0")) continue;
    const lines = text.split("\n").filter((line) => OLD_NAME.test(withoutKept(line))).map((line) => line.trim());
    if (lines.length > 0) found[path] = lines;
  }
  return found;
}

/** Reviewed findings per file: the hash of each offending line, sorted, with repeats. */
export function findMatches(files, read) {
  const found = {};
  for (const [path, lines] of Object.entries(findLines(files, read))) found[path] = lines.map(lineHash).sort();
  return found;
}

const tally = (lines) => {
  const map = new Map();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
};

/** Findings that no baseline entry covers. A line may appear as often as the baseline lists it, no more. */
export function compare(found, baseline) {
  const problems = [];
  for (const [path, lines] of Object.entries(found)) {
    const allowed = tally(baseline[path] ?? []);
    for (const [line, n] of tally(lines)) {
      if (n > (allowed.get(line) ?? 0)) problems.push({ path, line, found: n, allowed: allowed.get(line) ?? 0 });
    }
  }
  return problems;
}

/** The baseline with every entry that is gone from the files removed. Never adds a path, a line or a repeat. */
export function lowerBaseline(found, baseline) {
  const next = {};
  for (const [path, lines] of Object.entries(baseline)) {
    const have = tally(found[path] ?? []);
    const kept = [];
    for (const line of lines) {
      if ((have.get(line) ?? 0) > 0) {
        kept.push(line);
        have.set(line, have.get(line) - 1);
      }
    }
    if (kept.length > 0) next[path] = kept.sort();
  }
  return next;
}

const sameBaseline = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
  const reader = (path) => readFileSync(join(root, path), "utf8");
  const found = findMatches(files, reader);
  const baselinePath = join(root, BASELINE);
  const hashAt = process.argv.indexOf("--hash");
  if (hashAt > -1) { console.log(lineHash(process.argv[hashAt + 1] ?? "")); return; }
  if (process.argv.includes("--init")) {
    if (existsSync(baselinePath)) { console.error(`${BASELINE} exists. --init only creates it.`); process.exit(1); }
    writeFileSync(baselinePath, `${JSON.stringify(found, null, 2)}\n`);
    console.log(`baseline created: ${Object.keys(found).length} files`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (process.argv.includes("--update")) {
    const next = lowerBaseline(found, baseline);
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    const problems = compare(found, next);
    console.log(`baseline lowered: ${Object.keys(next).length} files. It never adds a path or a line.`);
    if (problems.length) { report(problems, files, reader); process.exit(1); }
    return;
  }
  const problems = compare(found, baseline);
  if (problems.length) { report(problems, files, reader); process.exit(1); }
  if (!sameBaseline(lowerBaseline(found, baseline), baseline)) console.log("Note: some baseline entries are gone. Run with --update to lock in the lower baseline.");
  console.log("ok: no new old-name matches");
}

function report(problems, files, reader) {
  const text = new Map();
  for (const [path, lines] of Object.entries(findLines(files, reader))) for (const line of lines) text.set(`${path}\0${lineHash(line)}`, line);
  console.error("New use of an old upstream name (omb, OMB_, OpenMausBot, MausBot, milind-soni):");
  for (const { path, line, found, allowed } of problems) {
    console.error(`  ${path}: ${found} x, ${allowed} allowed: ${(text.get(`${path}\0${line}`) ?? line).slice(0, 120)}`);
  }
  console.error("Use the Seira name. If this is a documented legacy fallback or attribution, say so in the PR and a reviewer adds the line hash to scripts/brand-names-baseline.json (node scripts/check-brand-names.mjs --hash '<line>').");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
