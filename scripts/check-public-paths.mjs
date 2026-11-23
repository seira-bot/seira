#!/usr/bin/env node
// Stops a change that ADDS a file under a path that belongs in a private place. See "Private by default" in AGENTS.md.
// A change to a file that is already tracked passes: only a new file (or a rename into a private path) fails.
//
//   node scripts/check-public-paths.mjs                  files added since origin/main, plus untracked files
//   node scripts/check-public-paths.mjs --staged         files added in the index (the pre-commit hook)
//   node scripts/check-public-paths.mjs --against <rev>  files added since <rev> (CI passes the base of the pull request)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { warnIfHooksOff } from "./hooks-notice.mjs";

const underRoot = (prefix) => (path) => path.startsWith(prefix);
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
const isTemplate = (path) => path.endsWith(".example");

/** Add one line here to make another path private. */
export const PRIVATE_PATHS = [
  { test: underRoot("docs/plans/"), reason: "a plan is a task note" },
  { test: underRoot("docs/superpowers/"), reason: "a plan or spec is a task note" },
  { test: underRoot("docs/specs/"), reason: "a spec is a task note" },
  { test: underRoot("docs/requirements/"), reason: "a requirements note is a task note" },
  { test: underRoot("internal/"), reason: "internal/ is local only" },
  { test: underRoot(".tmpexp/"), reason: "an experiment is scratch" },
  { test: (path) => /\.bak\d*$/.test(path), reason: "a backup is scratch" },
  { test: (path) => ["AGENTS.local.md", "CLAUDE.local.md"].includes(baseName(path)), reason: "a local note holds one machine's details" },
  { test: (path) => baseName(path).endsWith(".local"), reason: "a *.local file holds one machine's details" },
  { test: (path) => /^\.dev\.vars(?:\..+)?$/.test(baseName(path)) && !isTemplate(path), reason: "a .dev.vars file holds secrets" },
  { test: (path) => /^\.env(?:\..+)?$/.test(baseName(path)) && !isTemplate(path), reason: "an .env file holds secrets" },
];

export const MOVE_HINT = "Keep these files in internal/ (local only), in a private repository, or do not keep them. See \"Private by default\" in AGENTS.md.";

export function findPrivatePaths(addedPaths) {
  const found = [];
  for (const path of addedPaths) {
    const rule = PRIVATE_PATHS.find(({ test }) => test(path));
    if (rule) found.push({ path, reason: rule.reason });
  }
  return found;
}

/** Paths from `git diff --name-status -z`: an added file, or the new name of a file renamed from outside a private path. */
export function addedFromNameStatus(output) {
  const parts = output.split("\0").filter(Boolean);
  const added = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (status.startsWith("R")) {
      const [from, to] = [parts[i + 1], parts[i + 2]];
      if (!findPrivatePaths([from]).length) added.push(to);
      i += 3;
    } else {
      if (status === "A") added.push(parts[i + 1]);
      i += status.startsWith("C") ? 3 : 2;
    }
  }
  return added;
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
const gitOk = (args, cwd) => {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
};

function addedPaths({ staged, against }, root) {
  const diff = (...range) => addedFromNameStatus(git(["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--diff-filter=ARC", ...range], root));
  if (staged) return diff("--cached");
  const resolvable = (rev) => rev && gitOk(["rev-parse", "-q", "--verify", `${rev}^{commit}`], root);
  let base = resolvable(against) ? against : null;
  if (!base && gitOk(["rev-parse", "-q", "--verify", "origin/main"], root)) base = git(["merge-base", "HEAD", "origin/main"], root).trim();
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"], root).split("\0").filter(Boolean);
  return [...(base ? diff(base) : []), ...untracked];
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { staged: { type: "boolean" }, against: { type: "string" } } }));
  } catch {
    console.error("usage: node scripts/check-public-paths.mjs [--staged | --against <rev>]");
    return 2;
  }
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  warnIfHooksOff(root, "check-public-paths");
  if (gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], root)) return 0;
  const found = findPrivatePaths(addedPaths(values, root));
  for (const { path, reason } of found) console.log(`${path}: ${reason}`);
  if (found.length === 0) return 0;
  console.log(`\ncheck-public-paths: ${MOVE_HINT}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
