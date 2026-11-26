// Decides if a release run needs a person. It reads every commit since the last version on npm and the pull
// request that merged it. Only the gated npm publish workflow can publish to npm, so each version on npm passed the gate
// or waited in the `release-approval` environment. It only reads from GitHub, through `gh api`.
// A pull request passes when a trusted author wrote it (the list is .github/release-trusted-authors.json on main), the
// reviewer App approved its final head commit, and it touches no sensitive path.
// Exit status: 0 the run may publish with no wait, 1 the run waits in `release-approval` first, 2 refuse, wrong use or an API error.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repoFromRemote } from "./release-preflight.mjs";

const SHA = /^[0-9a-f]{40}$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;
/** The one file that lists the trusted authors. The gate reads it from `main` through the API, never from the pull request under review. */
export const TRUSTED_AUTHORS_PATH = ".github/release-trusted-authors.json";
const PAGE = 100;

/** The npm package that npm-publish.yml publishes. A fixed name: a pull request cannot move the baseline to another package. */
export const NPM_PACKAGE = "@seira-bot/seira";

export const SENSITIVE_PATTERNS = [".github/**", "scripts/release-*", "scripts/git-hooks/**", "pnpm-workspace.yaml", ".npmrc", "**/.npmrc"];

export const USAGE = `Usage: node scripts/release-gate.mjs --tag v<x.y.z> [--repo <owner>/<name>]
       node scripts/release-gate.mjs --sha <40-hex sha> [--repo <owner>/<name>]
       node scripts/release-gate.mjs --tag v<x.y.z> --sha <40-hex sha>  (the tag must point to the sha)
Environment: RELEASE_HUMAN_REVIEWERS is a JSON array of the logins of the human reviewers.`;

export class UsageError extends Error {
  exitCode = 2;
}

export function parseArgs(argv) {
  const out = { tag: null, sha: null, repo: null, help: false };
  const values = { "--tag": "tag", "--sha": "sha", "--repo": "repo" };
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
  if (!out.tag && !out.sha) throw new UsageError("give --tag, --sha, or both");
  if (out.tag && !SEMVER.test(out.tag)) throw new UsageError("--tag must look like v1.2.3");
  if (out.sha && !SHA.test(out.sha)) throw new UsageError("--sha must be a full 40-character sha");
  if (out.repo && !/^[\w.-]+\/[\w.-]+$/.test(out.repo)) throw new UsageError("--repo must look like owner/name");
  return out;
}

/** Reads the JSON array of logins. Anything else is an empty list. */
export function parseReviewers(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { logins: [], valid: true };
  try {
    const value = JSON.parse(String(text));
    if (Array.isArray(value)) return { logins: value.filter((item) => typeof item === "string" && item !== "").map((item) => item.toLowerCase()), valid: true };
  } catch {
    // An invalid value is treated as an empty list below.
  }
  return { logins: [], valid: false };
}

const escapeRegex = (text) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** `**` matches any text, `*` and `?` match inside one path part only. */
export function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const rest = pattern.slice(i);
    if (rest.startsWith("**/")) {
      source += "(?:.*/)?";
      i += 2;
    } else if (rest.startsWith("**")) {
      source += ".*";
      i += 1;
    } else if (pattern[i] === "*") source += "[^/]*";
    else if (pattern[i] === "?") source += "[^/]";
    else source += escapeRegex(pattern[i]);
  }
  return new RegExp(`^${source}$`);
}

const SENSITIVE_MATCHERS = SENSITIVE_PATTERNS.map(globToRegExp);

export const isSensitivePath = (path) => SENSITIVE_MATCHERS.some((matcher) => matcher.test(path));

/** The sensitive paths that a changed-file entry touches. A rename counts both its names. */
export function sensitiveFiles(files) {
  const found = new Set();
  for (const file of files) {
    for (const name of [file.filename, file.previous_filename]) if (typeof name === "string" && isSensitivePath(name)) found.add(name);
  }
  return [...found];
}

const versionOf = (tag) => {
  const match = SEMVER.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The highest plain version lower than `currentTag`. With no `currentTag`, the highest version. Returns a tag or null. */
export function baselineTag(versions, currentTag = null) {
  const current = currentTag ? versionOf(currentTag) : null;
  let best = null;
  for (const name of versions) {
    if (!PLAIN_VERSION.test(name)) continue;
    const version = versionOf(`v${name}`);
    if (current && compareVersions(version, current) >= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag: `v${name}`, version };
  }
  return best ? best.tag : null;
}

/** The versions that npm lists for a package. A registry error or bad JSON throws. */
export async function npmVersions(fetchJson, name) {
  const body = await fetchJson(`https://registry.npmjs.org/${name.replaceAll("/", "%2F")}`);
  if (!body || typeof body !== "object" || !body.versions || typeof body.versions !== "object") throw new Error(`the npm registry answer for ${name} has no versions`);
  return Object.keys(body.versions);
}

/**
 * A listed person approved when the latest review of that person that counts is APPROVED, and it covers the final head
 * commit of the pull request. A comment changes nothing. An approval of an older commit does not count.
 */
export function humanApproved(reviews, logins, headSha) {
  const latest = new Map();
  for (const review of reviews) {
    const login = String(review.user?.login ?? "").toLowerCase();
    if (!logins.includes(login) || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    latest.set(login, review);
  }
  return [...latest.values()].some((review) => review.state === "APPROVED" && Boolean(headSha) && review.commit_id === headSha);
}

/** One list is valid when each entry has exactly a string login and a positive integer ID, with no duplicate ID or login. */
function validEntries(list) {
  if (!Array.isArray(list)) return null;
  const ids = new Set();
  const logins = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes("login") || !keys.includes("id")) return null;
    if (typeof item.login !== "string" || item.login === "" || !Number.isInteger(item.id) || item.id <= 0) return null;
    const login = item.login.toLowerCase();
    if (ids.has(item.id) || logins.has(login)) return null;
    ids.add(item.id);
    logins.add(login);
  }
  return list.map((item) => ({ login: item.login, id: item.id }));
}

/** Reads the trusted-author file. Any fault in the file gives empty lists, so every pull request needs a person. */
export function parseTrustedAuthors(text) {
  try {
    const value = JSON.parse(String(text));
    if (value && typeof value === "object" && !Array.isArray(value) && value.version === 1) {
      const bots = validEntries(value.botAuthors);
      const admins = validEntries(value.adminAuthors);
      const reviewers = validEntries(value.reviewerApps);
      if (bots && admins && reviewers) return { bots, admins, reviewers, valid: true };
    }
  } catch {
    // Bad JSON is treated as empty lists below.
  }
  return { bots: [], admins: [], reviewers: [], valid: false };
}

/** An account matches an entry only when the type, the numeric ID, and the login all agree. A login alone never counts. */
const accountMatches = (user, type, entries) =>
  Boolean(user) && user.type === type && entries.some((entry) => entry.id === user.id && entry.login.toLowerCase() === String(user.login ?? "").toLowerCase());

/** The kind of trusted author: "bot" for a listed App, "admin" for a listed person who still needs a permission check, or null. */
export function authorKind(user, trusted) {
  if (accountMatches(user, "Bot", trusted.bots)) return "bot";
  if (accountMatches(user, "User", trusted.admins)) return "admin";
  return null;
}

/**
 * The reviewer App approved when its latest review that counts is APPROVED and covers the final head commit. The review
 * must come from a listed Bot account with the listed ID.
 */
export function reviewerApproved(reviews, trusted, headSha) {
  const latest = new Map();
  for (const review of reviews) {
    if (!accountMatches(review.user, "Bot", trusted.reviewers) || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    latest.set(review.user.id, review);
  }
  return [...latest.values()].some((review) => review.state === "APPROVED" && Boolean(headSha) && review.commit_id === headSha);
}

/** The shared account of the bots. It never counts as a human reviewer. */
const SHARED_ACCOUNT = { login: "RamaAditya49", id: 213913142 };

/** The reasons why a merged pull request needs a person. An empty list means the pull request passes. */
export function evaluatePull({ pull, detail = pull, files, reviews, logins, trusted = parseTrustedAuthors(""), isAdmin = false }) {
  const reasons = [];
  const user = detail.user ?? pull.user;
  const kind = authorKind(user, trusted);
  const authorOk = kind === "bot" || (kind === "admin" && isAdmin);
  if (!authorOk) reasons.push(`author ${user?.login ?? "unknown"} is not a trusted author (${kind === "admin" ? "admin permission not confirmed" : "not in the list on main"})`);
  else if (!reviewerApproved(reviews, trusted, detail.head?.sha)) reasons.push("the reviewer App has no approval of the final head commit");
  // A listed human approval may clear only the two author reasons. Evidence faults and sensitive paths always stay.
  // With an invalid list, no human review clears anything. The shared account is never a human reviewer: it is fixed here,
  // so the exclusion holds also when the list is invalid or the account is missing from it.
  const humanLogins = logins.filter((login) => login !== SHARED_ACCOUNT.login.toLowerCase());
  const humanReviews = reviews.filter((review) => review.user?.id !== SHARED_ACCOUNT.id);
  const cleared = reasons.length > 0 && trusted.valid === true && humanApproved(humanReviews, humanLogins, detail.head?.sha);
  const kept = cleared ? [] : reasons;
  if (typeof detail.changed_files === "number" && detail.changed_files > files.length) kept.push(`the file list is incomplete (${files.length} of ${detail.changed_files})`);
  const touched = sensitiveFiles(files);
  if (touched.length > 0) kept.push(`it changes a sensitive path: ${touched.join(", ")}`);
  return kept;
}

/** The merged pull request whose merge commit is `sha` on main, or null. */
export function mergedPullFor(pulls, sha) {
  return pulls.find((pull) => pull.merged_at && pull.base?.ref === "main" && pull.merge_commit_sha === sha) ?? null;
}

async function paged(api, path, pick = (body) => body) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = pick(await api(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`));
    items.push(...batch);
    if (batch.length < PAGE) return items;
  }
}

/** The trusted-author file on `main`. A missing file or bad JSON gives empty lists. Any other API error throws, so the run is refused. */
async function readTrustedAuthors(api, repo) {
  let body;
  try {
    body = await api(`repos/${repo}/contents/${TRUSTED_AUTHORS_PATH}?ref=main`);
  } catch (error) {
    if (error.status === 404) return parseTrustedAuthors("");
    throw error;
  }
  if (body?.encoding !== "base64" || typeof body.content !== "string") return parseTrustedAuthors("");
  return parseTrustedAuthors(Buffer.from(body.content, "base64").toString("utf8"));
}

/** True only when the API says the account has admin permission on the repository. Any error counts as no. */
async function hasAdminPermission(api, repo, login) {
  try {
    return (await api(`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)).permission === "admin";
  } catch {
    return false;
  }
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

async function commitsSince(api, repo, base, head) {
  const commits = [];
  let status = "unknown";
  let total = 0;
  for (let page = 1; ; page++) {
    const body = await api(`repos/${repo}/compare/${base}...${head}?per_page=${PAGE}&page=${page}`);
    status = body.status;
    total = body.total_commits ?? 0;
    const batch = body.commits ?? [];
    commits.push(...batch);
    if (commits.length >= total || batch.length === 0) return { commits, status, total };
  }
}

const short = (sha) => sha.slice(0, 7);

/** Runs every check, logs one line per check and returns the exit status. */
export async function releaseGate({ api, fetchJson, repo = "owner/name", npmPackage = NPM_PACKAGE, tag = null, sha = null, reviewers = "", log = console.log, summary = () => {} }) {
  const lines = [];
  let flagged = false;
  const say = (kind, text) => {
    const line = `${kind.padEnd(4)} ${text}`;
    lines.push(line);
    log(line);
  };
  const flag = (text) => {
    flagged = true;
    say("FLAG", text);
  };
  const finish = (code, verdict) => {
    log(verdict);
    summary(`## Release gate\n\n**${verdict}**\n\n${lines.map((line) => `- \`${line}\``).join("\n")}\n`);
    return code;
  };

  const { logins, valid } = parseReviewers(reviewers);
  if (!valid) say("note", "RELEASE_HUMAN_REVIEWERS is not a JSON array, so it counts as an empty list");

  const trusted = await readTrustedAuthors(api, repo);
  if (!trusted.valid) say("note", `${TRUSTED_AUTHORS_PATH} on main is missing or not valid, so no author is trusted`);

  let commit = sha;
  if (tag) {
    const tagged = await tagCommit(api, repo, tag);
    if (!tagged) {
      say("FAIL", `tag ${tag} does not exist in ${repo}`);
      return finish(2, "Release gate refused: the tag does not exist.");
    }
    if (sha && tagged !== sha) {
      say("FAIL", `tag ${tag} points to ${tagged}, not to ${sha}`);
      return finish(2, "Release gate refused: the tag does not point to the commit of this run.");
    }
    commit = tagged;
  }
  say("ok", `commit ${commit}`);

  const { status } = await api(`repos/${repo}/compare/${commit}...main`);
  if (status !== "ahead" && status !== "identical") {
    say("FAIL", `commit is not on main (compare status: ${status})`);
    return finish(2, "Release gate refused: the commit is not on main.");
  }
  say("ok", "commit is on main");

  const previous = baselineTag(await npmVersions(fetchJson, npmPackage), tag);
  let commits = [];
  if (!previous) flag(`no earlier version of ${npmPackage} on npm, so the whole history needs a person`);
  else {
    let range = null;
    try {
      range = await commitsSince(api, repo, previous, commit);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (!range) flag(`the tag ${previous} of the last npm version does not exist`);
    else {
      commits = range.commits;
      say("ok", `${range.total} commit(s) since ${previous}, the last version on npm (compare status: ${range.status})`);
      if (range.total === 0 && tag) flag(`no commits since the previous release ${previous}`);
      if (range.total === 0 && !tag && range.status === "identical") say("ok", `the commit is ${previous}, the last version on npm`);
      if (range.status !== "ahead" && range.status !== "identical") flag(`${previous} is not an ancestor of the commit (compare status: ${range.status})`);
      if (commits.length < range.total) flag(`the commit list is cut short (${commits.length} of ${range.total})`);
    }
  }

  const verdicts = new Map();
  for (const item of commits) {
    const pulls = await api(`repos/${repo}/commits/${item.sha}/pulls?per_page=${PAGE}`);
    const pull = mergedPullFor(pulls, item.sha);
    if (!pull) {
      flag(`${short(item.sha)} is a commit without a merged pull request`);
      continue;
    }
    if (!verdicts.has(pull.number)) {
      const files = await paged(api, `repos/${repo}/pulls/${pull.number}/files`);
      const reviews = await paged(api, `repos/${repo}/pulls/${pull.number}/reviews`);
      const detail = await api(`repos/${repo}/pulls/${pull.number}`);
      const user = detail.user ?? pull.user;
      const isAdmin = authorKind(user, trusted) === "admin" && (await hasAdminPermission(api, repo, user.login));
      verdicts.set(pull.number, evaluatePull({ pull, detail, files, reviews, logins, trusted, isAdmin }));
    }
    const reasons = verdicts.get(pull.number);
    if (reasons.length === 0) say("ok", `${short(item.sha)} pull request #${pull.number} passes`);
    else for (const reason of reasons) flag(`${short(item.sha)} pull request #${pull.number}: ${reason}`);
  }

  return flagged
    ? finish(1, "Release gate flagged this run. It waits in release-approval, and a maintainer can cancel it.")
    : finish(0, "Release gate passed. The run may publish with no wait.");
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
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? repoFromRemote(execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }));
  if (!repo) throw new UsageError("could not read the GitHub repository; pass --repo");
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  process.exitCode = await releaseGate({
    api: async (path) => ghApi(path),
    fetchJson: async (url) => {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
      return response.json();
    },
    repo,
    tag: args.tag,
    sha: args.sha,
    reviewers: process.env.RELEASE_HUMAN_REVIEWERS,
    summary: summaryFile ? (text) => appendFileSync(summaryFile, text) : undefined,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-gate: ${error.message}`);
    if (error instanceof UsageError) console.error(USAGE);
    process.exitCode = 2;
  });
}
