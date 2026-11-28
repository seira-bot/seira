// Refuses a release while a P0 issue is open, or while a draft or triage security advisory of severity high or critical
// does not show that the release version is safe: its range covers the version, does not parse, or is missing,
// and no patched version covers the version. It only reads from GitHub, through `gh api`.
// Actions logs of this repository are public, and draft and triage advisories are private.
// So it prints the number of each blocking issue but only the count of blocking advisories.
// `--details` also prints the id, severity and state of each advisory. Use it only where the output stays private.
// Exit status: 0 nothing blocks the release, 1 something blocks it, 2 wrong use or an API error.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const PAGE = 100;
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const OPEN_ADVISORY_STATES = ["draft", "triage"];
export const BLOCKING_LABEL = "P0";

export const USAGE = "Usage: node scripts/release-blockers.mjs --version <x.y.z> [--repo <owner>/<name>] [--details]";

export class UsageError extends Error {
  exitCode = 2;
}

export function parseArgs(argv) {
  const out = { version: null, repo: null, help: false, details: false };
  const values = { "--version": "version", "--repo": "repo" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--details") out.details = true;
    else if (arg in values) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      out[values[arg]] = value;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (out.help) return out;
  if (!out.version || !PLAIN_VERSION.test(out.version)) throw new UsageError("--version must look like 1.2.3");
  if (out.repo && !/^[\w.-]+\/[\w.-]+$/.test(out.repo)) throw new UsageError("--repo must look like owner/name");
  return out;
}

const parts = (version) => {
  const match = PLAIN_VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

const CONSTRAINT = /^\s*(>=|>|<=|<|==|=)?\s*v?(\d+\.\d+\.\d+)\s*$/;

const holds = (operator, order) => {
  switch (operator) {
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    default:
      return order === 0;
  }
};

/**
 * True when one entry of the patched versions covers `version`. The entries are separated by commas.
 * A bare version or `>= x` covers every version from x. `> x` and `= x` work as written.
 * An upper bound (`<`, `<=`) names no patched version, so it covers nothing.
 */
export function versionCovers(patched, version) {
  const release = parts(version);
  if (!release || typeof patched !== "string") return false;
  return patched.split(",").some((entry) => {
    const match = CONSTRAINT.exec(entry);
    if (!match || match[1]?.startsWith("<")) return false;
    return holds(match[1] ?? ">=", compare(release, parts(match[2])));
  });
}

/**
 * True when the vulnerable version range covers `version`, false when it does not, null when it does not parse.
 * The constraints are separated by commas, and all of them must hold. A bare version names that version only.
 */
export function rangeCovers(range, version) {
  const release = parts(version);
  if (!release || typeof range !== "string" || range.trim() === "") return null;
  let covers = true;
  for (const entry of range.split(",")) {
    const match = CONSTRAINT.exec(entry);
    if (!match) return null;
    if (!holds(match[1] ?? "=", compare(release, parts(match[2])))) covers = false;
  }
  return covers;
}

/** Why an open advisory blocks `version`: "affected", "unknown" when no range shows that the version is safe, or null. */
export function advisoryBlock(advisory, version) {
  const vulnerabilities = advisory.vulnerabilities ?? [];
  if (vulnerabilities.length === 0) return "unknown";
  let unknown = false;
  for (const item of vulnerabilities) {
    if (versionCovers(item.patched_versions, version)) continue;
    const covers = rangeCovers(item.vulnerable_version_range, version);
    if (covers === true) return "affected";
    if (covers === null) unknown = true;
  }
  return unknown ? "unknown" : null;
}

/** The numbers of the blocking issues and the blocking advisories. `issues` are open issues with the P0 label, `advisories` carry a `state` field. */
export function judgeBlockers({ issues, advisories, version }) {
  const found = { issues: [], advisories: [] };
  for (const issue of issues) if (!issue.pull_request) found.issues.push(issue.number);
  for (const advisory of advisories) {
    if (!OPEN_ADVISORY_STATES.includes(advisory.state)) continue;
    const severity = String(advisory.severity ?? "").toLowerCase();
    if (!BLOCKING_SEVERITIES.has(severity)) continue;
    const reason = advisoryBlock(advisory, version);
    if (reason) found.advisories.push({ id: advisory.ghsa_id, severity, state: advisory.state, reason });
  }
  return found;
}

async function paged(api, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`);
    items.push(...batch);
    if (batch.length < PAGE) return items;
  }
}

/** Reads the open P0 issues and the open advisories, logs one line per blocker and returns the exit status. */
export async function releaseBlockers({ api, repo = "owner/name", version, details = false, log = console.log }) {
  const issues = await paged(api, `repos/${repo}/issues?state=open&labels=${BLOCKING_LABEL}`);
  const advisories = [];
  for (const state of OPEN_ADVISORY_STATES) {
    const found = await paged(api, `repos/${repo}/security-advisories?state=${state}`);
    advisories.push(...found.map((advisory) => ({ ...advisory, state })));
  }
  const found = judgeBlockers({ issues, advisories, version });
  for (const number of found.issues) log(`FAIL issue #${number} has the label ${BLOCKING_LABEL}`);
  const count = found.advisories.length;
  if (count > 0) {
    log(`FAIL ${count} security ${count === 1 ? "advisory blocks" : "advisories block"} release ${version}. Run this script with --details where the output stays private.`);
    if (details) {
      for (const advisory of found.advisories) {
        const why = advisory.reason === "affected" ? `affects ${version} and has no patched version that covers it` : `has no version range that shows ${version} is safe`;
        log(`     advisory ${advisory.id} (${advisory.severity}, ${advisory.state}) ${why}`);
      }
    }
  }
  if (found.issues.length + count > 0) {
    log(`Release ${version} is blocked.`);
    return 1;
  }
  log(`ok   no open ${BLOCKING_LABEL} issue and no unpatched high or critical advisory blocks release ${version}`);
  return 0;
}

function ghApi(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    const text = String(error.stderr ?? error.message);
    throw new Error(text.trim().split("\n")[0] || "gh api failed");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) throw new UsageError("could not read the GitHub repository; pass --repo");
  process.exitCode = await releaseBlockers({ api: async (path) => ghApi(path), repo, version: args.version, details: args.details });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-blockers: ${error.message}`);
    if (error instanceof UsageError) console.error(USAGE);
    process.exitCode = 2;
  });
}
