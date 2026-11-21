// Refuses a release unless every check on the release commit is green, a CI run proved the release tree, the tag and
// the package.json version agree, and main is green. It only reads from GitHub, through `gh api`.
// Exit status: 0 every check passed, 1 a check failed, 2 wrong use or an API error.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const PROOF_EVENTS = new Set(["push", "workflow_dispatch", "merge_group"]);
const PASSING = new Set(["success", "skipped", "neutral"]);

export const USAGE = `Usage: node scripts/release-preflight.mjs --tag v<x.y.z> [--repo <owner>/<name>]
       node scripts/release-preflight.mjs --sha <40-hex sha> [--version <x.y.z>] [--repo <owner>/<name>]`;

export class UsageError extends Error {
  exitCode = 2;
}

export function parseArgs(argv) {
  const out = { tag: null, sha: null, version: null, repo: null, help: false };
  const values = { "--tag": "tag", "--sha": "sha", "--version": "version", "--repo": "repo" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg in values) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      out[values[arg]] = value;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (out.help) return out;
  if (!out.tag === !out.sha) throw new UsageError("give exactly one of --tag and --sha");
  if (out.tag && !/^v\d+\.\d+\.\d+$/.test(out.tag)) throw new UsageError("--tag must look like v1.2.3");
  if (out.sha && !SHA.test(out.sha)) throw new UsageError("--sha must be a full 40-character sha");
  if (out.version && !/^\d+\.\d+\.\d+$/.test(out.version)) throw new UsageError("--version must look like 1.2.3");
  if (out.tag && out.version) throw new UsageError("--version goes with --sha, not with --tag");
  if (out.repo && !/^[\w.-]+\/[\w.-]+$/.test(out.repo)) throw new UsageError("--repo must look like owner/name");
  return out;
}

export function repoFromRemote(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function newestBy(items, key, time) {
  const best = new Map();
  for (const item of items) {
    const old = best.get(item[key]);
    const a = item[time] ?? "";
    const b = old?.[time] ?? "";
    if (!old || a > b || (a === b && (item.id ?? 0) > (old.id ?? 0))) best.set(item[key], item);
  }
  return [...best.values()];
}

/** A re-run or a second check suite repeats a name. Only the newest run of a name counts. */
export const newestByName = (checkRuns) => newestBy(checkRuns, "name", "started_at");

/** The check suites of the dynamic Dependabot update runs. Their check runs do not test the release. */
export function dependabotSuites(workflowRuns) {
  const ids = workflowRuns.filter((item) => String(item.path ?? "").startsWith("dynamic/dependabot/") && item.check_suite_id != null).map((item) => item.check_suite_id);
  return new Set(ids);
}

export function judgeChecks(checkRuns, statuses = [], ignoredSuites = new Set()) {
  const failures = [];
  const pending = [];
  const superseded = [];
  const ignored = [];
  const counted = [];
  for (const run of checkRuns) {
    if (ignoredSuites.has(run.check_suite?.id)) ignored.push({ name: run.name, state: run.conclusion ?? run.status, url: run.html_url });
    else counted.push(run);
  }
  for (const run of newestByName(counted)) {
    const item = { name: run.name, state: run.conclusion ?? run.status, url: run.html_url };
    if (run.status !== "completed") pending.push(item);
    else if (run.conclusion === "cancelled") superseded.push(item);
    else if (!PASSING.has(run.conclusion)) failures.push(item);
  }
  for (const status of newestBy(statuses, "context", "updated_at")) {
    const item = { name: status.context, state: status.state, url: status.target_url };
    if (status.state === "pending") pending.push(item);
    else if (status.state !== "success") failures.push(item);
  }
  return { failures, pending, superseded, ignored };
}

/** The run that proves the release tree, or null. `runs` are successful runs of the CI workflow. */
export function ciProof({ checkRuns, runs, tree }) {
  const ci = newestByName(checkRuns).find((run) => run.name === "CI");
  if (ci && ci.status === "completed" && ci.conclusion === "success") return { how: "the CI check on the commit", url: ci.html_url };
  const run = runs.find((item) => item.conclusion === "success" && PROOF_EVENTS.has(item.event) && item.head_commit?.tree_id === tree);
  return run ? { how: `CI run ${run.id} (${run.event}) on a commit with the same tree`, url: run.html_url } : null;
}

/** Runs come newest first. A cancelled run was superseded, so the newest other finished run decides. */
export function mainVerdict(runs) {
  const run = runs.find((item) => item.conclusion && item.conclusion !== "cancelled" && (item.status ?? "completed") === "completed");
  if (!run) return { ok: false, reason: "no finished CI run on main that is not cancelled" };
  return run.conclusion === "success" ? { ok: true, run } : { ok: false, run, reason: `the newest finished CI run on main is ${run.conclusion}` };
}

async function allCheckRuns(api, repo, sha) {
  const found = [];
  for (let page = 1; ; page++) {
    const body = await api(`repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    found.push(...body.check_runs);
    if (found.length >= body.total_count || body.check_runs.length === 0) return found;
  }
}

async function dependabotRuns(api, repo, sha) {
  const body = await api(`repos/${repo}/actions/runs?head_sha=${sha}&event=dynamic&per_page=100`);
  return dependabotSuites(body.workflow_runs ?? []);
}

async function tagCommit(api, repo, tag) {
  let ref;
  try {
    ref = (await api(`repos/${repo}/git/ref/tags/${tag}`)).object;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  for (let depth = 0; ref.type === "tag" && depth < 3; depth++) ref = (await api(`repos/${repo}/git/tags/${ref.sha}`)).object;
  return ref.sha;
}

const describe = (item) => `${item.name} (${item.state})${item.url ? ` ${item.url}` : ""}`;

/** Runs every check, logs one line per check and returns the exit status. */
export async function preflight({ api, repo = "owner/name", tag, sha, version, log = console.log }) {
  let failed = false;
  const check = (ok, text) => {
    log(`${ok ? "ok  " : "FAIL"} ${text}`);
    if (!ok) failed = true;
  };

  let commit;
  try {
    commit = await api(`repos/${repo}/commits/${tag ?? sha}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    log(`FAIL ${tag ? `tag ${tag}` : `commit ${sha}`} does not exist in ${repo}`);
    return 1;
  }
  sha = commit.sha;
  const tree = commit.commit.tree.sha;
  log(`ok   commit ${sha}, tree ${tree}`);

  const file = await api(`repos/${repo}/contents/package.json?ref=${sha}`);
  const packageVersion = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).version;
  if (tag) check(packageVersion === tag.slice(1), `tag ${tag} and package.json version ${packageVersion}`);
  else {
    check(!version || version === packageVersion, `package.json version ${packageVersion}${version ? ` and requested version ${version}` : ""}`);
    const existing = await tagCommit(api, repo, `v${version ?? packageVersion}`);
    const text = existing === null ? "does not exist yet" : `points to ${existing}${existing === sha ? "" : ", not to this commit"}`;
    check(existing === null || existing === sha, `tag v${version ?? packageVersion} ${text}`);
  }
  const releaseTag = tag ?? `v${version ?? packageVersion}`;

  const { status } = await api(`repos/${repo}/compare/${sha}...main`);
  check(status === "ahead" || status === "identical", `commit is on main (compare status: ${status})`);

  const checkRuns = await allCheckRuns(api, repo, sha);
  const statuses = (await api(`repos/${repo}/commits/${sha}/status?per_page=100`)).statuses ?? [];
  const { failures, pending, superseded, ignored } = judgeChecks(checkRuns, statuses, await dependabotRuns(api, repo, sha));
  for (const item of failures) check(false, `check ${describe(item)}`);
  for (const item of pending) check(false, `check not finished: ${describe(item)}`);
  for (const item of superseded) log(`note ${item.name} was cancelled (superseded), so it proves nothing`);
  for (const item of ignored) log(`note ${item.name} (${item.state}) is a Dependabot update run, so it does not block the release`);
  if (failures.length + pending.length === 0) check(true, `no failed or unfinished check on the commit (${newestByName(checkRuns).length} runs, ${statuses.length} statuses)`);

  const successful = await api(`repos/${repo}/actions/workflows/ci.yml/runs?status=success&per_page=100`);
  const proof = ciProof({ checkRuns, runs: successful.workflow_runs, tree });
  if (proof) check(true, `CI proof: ${proof.how} ${proof.url}`);
  else {
    check(false, "no CI run proves this tree");
    log(`     Start CI on the tag: gh workflow run ci.yml --ref ${releaseTag}`);
    log("     Wait until that run succeeds, then run this preflight again.");
  }

  const main = await api(`repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=30`);
  const verdict = mainVerdict(main.workflow_runs);
  check(verdict.ok, verdict.ok ? `main is green ${verdict.run.html_url}` : `${verdict.reason}${verdict.run ? ` ${verdict.run.html_url}` : ""}`);

  log(failed ? "Preflight FAILED. Do not publish this release." : "Preflight passed.");
  return failed ? 1 : 0;
}

function ghApi(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    const text = String(error.stderr ?? error.message);
    const wrapped = new Error(text.trim().split("\n")[0] || "gh api failed");
    wrapped.status = /HTTP 404/.test(text) ? 404 : undefined;
    throw wrapped;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const repo = args.repo ?? repoFromRemote(origin);
  if (!repo) throw new UsageError("could not read the GitHub repository from the origin remote; pass --repo");
  process.exitCode = await preflight({ api: async (path) => ghApi(path), repo, tag: args.tag, sha: args.sha, version: args.version });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-preflight: ${error.message}`);
    if (error instanceof UsageError) console.error(USAGE);
    process.exitCode = 2;
  });
}
