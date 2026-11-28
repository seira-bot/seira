#!/usr/bin/env node
// Finds details of one person's machine (home paths, `ls -l` owners, keys, and the private
// patterns in .leakcheck.local) in the lines a change adds. See "Local details stay local" in AGENTS.md.
//
//   node scripts/check-local-leaks.mjs            lines added since origin/main, plus untracked files
//   node scripts/check-local-leaks.mjs --staged   lines added in the index (the pre-commit hook)
//   node scripts/check-local-leaks.mjs --all      every line of every file (an audit of the whole tree);
//                                                 reads scripts/check-local-leaks.audit-allow.json
//
// .leakcheck.local (gitignored) holds one regular expression per line, matched without case:
// your user name, host aliases, LAN addresses, private repo names. They apply to every file.
// The generic rules skip tests, fixtures and generated files, and a merge commit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { warnIfHooksOff } from "./hooks-notice.mjs";

const PLACEHOLDERS = "node|runner|user|username|you|yourname|your-name|me|name|alice|bob|ubuntu|pi|app|seira|root|shared|public|default|guest|cua";
const notPlaceholder = `(?!(?:${PLACEHOLDERS})(?:[/\\\\]|$))`;

const NOT_A_SECRET_VALUE = [
  "[$<{]",
  "(?:[a-z]\\w*\\.)+[A-Z][A-Z0-9_]*(?:[^\\w.]|$)", // reads a variable by name: parentEnv.SEIRA_X_TOKEN
  "[\"']?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+[\"']?(?:[\\s;,)]|$)", // an environment variable name
  "[\"']x-[a-z0-9-]+[\"']", // an HTTP header name
  "/\\^|\\[", // a regex literal or an array
  "[\"'](?:/[a-z0-9._@-]+){2,}[\"']", // an absolute path
  "[a-z]+[A-Z][A-Za-z]*[;,)]", // a bare identifier in code
  "\\S*(?:fixture|example)",
];
const SECRET_ASSIGNMENT = new RegExp(
  `\\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\\s*=\\s*(?!${NOT_A_SECRET_VALUE.join("|")})["']?[^\\s"'$<{]{16,}`,
);

export const GENERIC_RULES = [
  { label: "home folder path (Linux)", re: new RegExp(`(?<![\\w.:-])/home/${notPlaceholder}[A-Za-z0-9._-]+/`) },
  { label: "home folder path (macOS)", re: new RegExp(`(?<![\\w.:-])/Users/(?!(?:Shared|Guest)/)${notPlaceholder}[A-Za-z0-9._-]+/`) },
  { label: "home folder path (Windows)", re: new RegExp(`\\b[A-Za-z]:(?:\\\\{1,2}|/)Users(?:\\\\{1,2}|/)${notPlaceholder}[A-Za-z0-9._-]+`, "i") },
  { label: "ls -l output with owner names", re: /(?:^|\s)[-dl][-rwxsStT]{9}[.+@]?\s+\d+\s+[A-Za-z0-9._-]+\s+[A-Za-z0-9._-]+\s+\d+\s/ },
  { label: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { label: "provider API key", re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{20,})\b/ },
  { label: "secret value in an assignment", re: SECRET_ASSIGNMENT },
  { label: "internal-only marker", re: /INTERNAL[-]ONLY/ },
];

const EXEMPT = [
  /\.(?:test|spec|node-test|dom\.test)\.[cm]?[jt]sx?$/,
  /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|e2e|testing|vendor|node_modules)\//,
  /^evals\//,
  /\.snap$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)source-hashes\.json$/,
];

export const exemptFromGeneric = (path) => EXEMPT.some((re) => re.test(path));

export function privatePatterns(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => ({ label: "private pattern from .leakcheck.local", re: new RegExp(line, "i") }));
}

export function addedLines(diff) {
  const out = [];
  let path = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      path = raw === "+++ /dev/null" ? null : raw.slice(6).replace(/\t$/, "");
    } else if (raw.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (path && raw.startsWith("+")) {
      out.push({ path, line, text: raw.slice(1) });
      line += 1;
    }
  }
  return out;
}

export function fileLines(path, buffer) {
  const binary = buffer.subarray(0, 8000).includes(0);
  if (binary) return [{ path, line: 0, text: buffer.toString("latin1"), binary: true }];
  return buffer.toString("utf8").split("\n").map((text, i) => ({ path, line: i + 1, text }));
}

export function findLeaks(lines, { privateRules = [], generic = true } = {}) {
  const found = [];
  for (const { path, line, text, binary } of lines) {
    const rules = [...privateRules];
    if (generic && !exemptFromGeneric(path)) {
      rules.push(...(binary ? GENERIC_RULES.slice(0, 3) : GENERIC_RULES));
    }
    for (const { label, re } of rules) {
      if (re.test(text) || re.test(path)) found.push({ path, line, label, text });
    }
  }
  return found;
}

// Only `--all` reads this list. Each entry pins one finding: a file, a rule, the SHA-256 of the trimmed line text, and one reason.
// An entry hides one finding only. A new finding of the same rule in the same file stays in `kept`.
// An entry that no longer matches a finding is stale, and the audit fails so the list stays true. The generic rules stay as they are.
export const lineHash = (text) => createHash("sha256").update(text.trim()).digest("hex");

export function applyAuditAllow(found, allow) {
  const used = new Set();
  const kept = found.filter(({ path, label, text }) => {
    const hash = lineHash(text ?? "");
    const i = allow.findIndex((entry, n) => !used.has(n) && entry.path === path && entry.rule === label && entry.match === hash);
    if (i < 0) return true;
    used.add(i);
    return false;
  });
  const stale = allow.filter((_, i) => !used.has(i));
  return { kept, stale };
}

// Returns the entries, or throws an Error with one clear line when the file is not usable.
export function parseAuditAllow(raw, name = "check-local-leaks.audit-allow.json") {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON (${error.message})`);
  }
  if (!Array.isArray(data)) throw new Error(`${name} must be a JSON array`);
  data.forEach((entry, n) => {
    const ok = entry && typeof entry.path === "string" && typeof entry.rule === "string" && typeof entry.reason === "string" && /^[0-9a-f]{64}$/.test(entry.match ?? "");
    if (!ok) throw new Error(`${name} entry ${n + 1} needs path, rule, reason and a 64-digit hex match`);
  });
  return data;
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

function linesToCheck(mode, root) {
  const readFile = (path) => (existsSync(join(root, path)) ? fileLines(path, readFileSync(join(root, path))) : []);
  const list = (args) => git(args, root).split("\0").filter(Boolean);
  if (mode === "--all") {
    return list(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).flatMap(readFile);
  }
  const range = mode === "--staged" ? ["--cached"] : [gitOk(["rev-parse", "-q", "--verify", "origin/main"], root) ? git(["merge-base", "HEAD", "origin/main"], root).trim() : "HEAD"];
  const diffArgs = ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--diff-filter=ACM", ...range];
  const binaries = git([...diffArgs, "--numstat", "-z"], root)
    .split("\0")
    .filter((entry) => entry.startsWith("-\t-\t"))
    .map((entry) => entry.slice(4));
  const untracked = mode === "--staged" ? [] : list(["ls-files", "-z", "--others", "--exclude-standard"]);
  return [...addedLines(git(diffArgs, root)), ...binaries.flatMap(readFile), ...untracked.flatMap(readFile)];
}

function main(argv) {
  const mode = argv[0] ?? "";
  if (!["", "--staged", "--all"].includes(mode)) {
    console.error("usage: node scripts/check-local-leaks.mjs [--staged | --all]");
    return 2;
  }
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  warnIfHooksOff(root, "check-local-leaks");
  const localFile = join(root, ".leakcheck.local");
  const privateRules = existsSync(localFile) ? privatePatterns(readFileSync(localFile, "utf8")) : [];
  const merging = gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], root);
  let found = findLeaks(linesToCheck(mode, root), { privateRules, generic: !merging });
  let stale = [];
  if (mode === "--all") {
    const allowFile = join(root, "scripts/check-local-leaks.audit-allow.json");
    let allow = [];
    try {
      allow = existsSync(allowFile) ? parseAuditAllow(readFileSync(allowFile, "utf8")) : [];
    } catch (error) {
      console.log(`check-local-leaks: ${error.message}`);
      return 1;
    }
    ({ kept: found, stale } = applyAuditAllow(found, allow));
  }
  for (const { path, line, label } of found) console.log(`${path}:${line}: ${label}`);
  for (const { path, rule } of stale) console.log(`${path}: stale audit-allow entry (${rule})`);
  if (found.length === 0 && stale.length === 0) return 0;
  console.log("\ncheck-local-leaks: remove these details, or move them to a *.local file or AGENTS.local.md.");
  console.log('See "Local details stay local" in AGENTS.md.');
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
