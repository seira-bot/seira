// Creates the GitHub release for a Seira browser engine build, and never marks it Latest.
// releases/latest must stay the app release: deploy/install.sh, deploy/update.sh, server/update-check.ts and
// electron-updater (latest.yml) all read it. An engine release marked Latest breaks them.
// The tag is made at the commit that built the binary (--target, 40 hex characters, required), before the release exists:
// the script resolves the exact tag ref, creates a missing one at the build commit without force, reads it again and requires a match.
// Then `gh release create --verify-tag` runs, so GitHub never makes or moves a tag by itself.
// A lookup error other than a confirmed 404 stops the script. An existing tag is never moved.
// Before any tag or release is made, an active tag ruleset must cover this exact tag with `update` and `deletion` rules and no
// bypass actor. If the ruleset cannot be read, or its bypass list cannot be read, the script stops (fail closed).
// Exit status: 0 created, 1 `gh` failed or the tag is not on the build commit, 2 wrong use.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = /^browser-engine-v\d+\.\d+\.\d+-seira\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export const USAGE = "Usage: node scripts/publish-browser-engine-release.mjs <browser-engine-vX.Y.Z-seira.N> --target <40-hex build commit> [--repo <owner>/<name>] -- <file>...";

/** The `gh` arguments. `--latest=false` and `--target` are always present. Every flag comes before `--`, every asset path after it. */
export function engineReleaseArgs(tag, files, { target, repo = "seira-bot/seira" } = {}) {
  if (!TAG.test(tag ?? "")) throw new Error("the tag must look like browser-engine-v0.36.0-seira.2");
  if (!SHA.test(target ?? "")) throw new Error("--target must be the 40-character commit that built the binary");
  if (!REPO.test(repo)) throw new Error("--repo must look like owner/name");
  if (!files.length) throw new Error("give at least one file to upload");
  return ["release", "create", tag, "--repo", repo, "--title", tag, "--target", target, "--verify-tag", "--latest=false", "--notes", `Seira browser engine build ${tag}, built from ${target}. Not an app release.`, "--", ...files];
}

/** Parse argv: the tag, then flags, then `--` and the files. Nothing after `--` is read as a flag. */
export function parseArgs(argv) {
  const out = { tag: undefined, target: undefined, repo: undefined, files: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { out.files = argv.slice(i + 1); break; }
    if (arg === "--target" || arg === "--repo") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      out[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else if (out.tag === undefined) out.tag = arg;
    else throw new Error("put the files after --");
  }
  return out;
}

const COMMIT = /^[0-9a-f]{40}$/;

/** Runs `gh api`. Returns { ok: true, body } or { ok: false, status, error }. `status` is the HTTP status when `gh` printed one, else null. */
function ghApi(args) {
  try {
    return { ok: true, body: execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const text = String(error.stderr ?? error.message ?? "");
    const status = /HTTP (\d{3})/.exec(text);
    return { ok: false, status: status ? Number(status[1]) : null, error: text.trim().slice(0, 300) };
  }
}

/** The commit of `refs/tags/<tag>`: { commit } , { missing: true } (a confirmed 404 only), or { error }. Any other failure is an error, never "missing". */
export function resolveTag(repo, tag, api) {
  const ref = api([`repos/${repo}/git/ref/tags/${tag}`]);
  if (!ref.ok) return ref.status === 404 ? { missing: true } : { error: `cannot read ${tag}: ${ref.error || "no answer from GitHub"} (status ${ref.status ?? "unknown"})` };
  let object;
  try { object = JSON.parse(ref.body).object; } catch { return { error: `cannot read ${tag}: the answer is not JSON` }; }
  if (object?.type === "tag") {
    // An annotated tag: follow it to the commit.
    const tagObject = api([`repos/${repo}/git/tags/${object.sha}`]);
    if (!tagObject.ok) return { error: `cannot read the tag object of ${tag}: ${tagObject.error || "no answer from GitHub"}` };
    try { object = JSON.parse(tagObject.body).object; } catch { return { error: `cannot read the tag object of ${tag}` }; }
  }
  if (object?.type !== "commit" || !COMMIT.test(object.sha ?? "")) return { error: `${tag} does not point at a commit` };
  return { commit: object.sha };
}

const REQUIRED_INCLUDE = "refs/tags/browser-engine-v*";
const sameList = (value, expected) => Array.isArray(value) && value.length === expected.length && value.every((item, i) => item === expected[i]);

/**
 * Requires an active tag ruleset that covers the exact engine tag with `update` and `deletion` rules and has no bypass actor,
 * so the verified tag cannot be moved or deleted between the check and the release. Returns null when it does, else the reason.
 * Fails closed: a list or detail that cannot be read, or a ruleset without a readable `bypass_actors` list, never counts as protection.
 */
export function ensureTagProtection(repo, tag, api) {
  const ref = `refs/tags/${tag}`;
  const list = api([`repos/${repo}/rulesets?per_page=100`]);
  if (!list.ok) return `cannot read the rulesets of ${repo}: ${list.error || "no answer from GitHub"} (status ${list.status ?? "unknown"}). The engine tag cannot be shown to be protected. Nothing was published.`;
  let rulesets;
  try { rulesets = JSON.parse(list.body); } catch { return "cannot read the rulesets: the answer is not JSON. Nothing was published."; }
  if (!Array.isArray(rulesets)) return "cannot read the rulesets: the answer is not a list. Nothing was published.";
  if (rulesets.length >= 100) return "too many rulesets to check in one page. Nothing was published.";
  const why = [];
  for (const summary of rulesets) {
    if (summary?.target !== "tag") continue;
    const detail = api([`repos/${repo}/rulesets/${summary.id}`]);
    if (!detail.ok) return `cannot read ruleset ${summary.id}: ${detail.error || "no answer from GitHub"} (status ${detail.status ?? "unknown"}). Nothing was published.`;
    let rules;
    try { rules = JSON.parse(detail.body); } catch { return `cannot read ruleset ${summary.id}: the answer is not JSON. Nothing was published.`; }
    const name = `ruleset "${rules?.name ?? summary.id}"`;
    // Policy on the detail response only (the list's enforcement is never trusted). No generic glob matching: GitHub's fnmatch rules are not reimplemented.
    if (rules?.target !== "tag") { why.push(`${name} is not a tag ruleset`); continue; }
    if (rules?.enforcement !== "active") { why.push(`${name} is not active (enforcement ${JSON.stringify(rules?.enforcement ?? null)})`); continue; }
    const names = rules?.conditions?.ref_name;
    if (!sameList(names?.include, [REQUIRED_INCLUDE]) || !sameList(names?.exclude, [])) { why.push(`${name} does not have exactly include [${REQUIRED_INCLUDE}] and an empty exclude list`); continue; }
    const types = new Set((rules.rules ?? []).map((rule) => rule?.type));
    const missing = ["update", "deletion"].filter((type) => !types.has(type));
    if (missing.length) { why.push(`${name} covers ${ref} but has no ${missing.join(" and ")} rule`); continue; }
    if (!Array.isArray(rules.bypass_actors)) return `${name} covers ${ref}, but its bypass actors cannot be read with this token. Failing closed. Nothing was published.`;
    if (rules.bypass_actors.length > 0) { why.push(`${name} has ${rules.bypass_actors.length} bypass actor(s)`); continue; }
    return null;
  }
  return `no active tag ruleset protects ${ref} against update and deletion with no bypass${why.length ? ` (${why.join("; ")})` : ""}. Create the ruleset first (active, target tag, include exactly refs/tags/browser-engine-v*, empty exclude, rules update and deletion, no bypass). Nothing was published.`;
}

/**
 * Makes sure `refs/tags/<tag>` exists and points at the build commit. Returns null when it does, else the reason.
 * An existing tag is never moved. A missing tag is created at the build commit without force, then read again and compared.
 * Any lookup error other than a confirmed 404 stops the release.
 */
export function ensureTag(repo, tag, target, api) {
  const first = resolveTag(repo, tag, api);
  if (first.error) return first.error;
  if (first.commit !== undefined) {
    return first.commit === target ? null : `${tag} already points at ${first.commit}, not at the build commit ${target}. A tag is never moved. Record the real build commit in docs/browser-packaging.md.`;
  }
  const made = api(["-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/tags/${tag}`, "-f", `sha=${target}`]);
  if (!made.ok) return `cannot create ${tag} at ${target}: ${made.error || "no answer from GitHub"} (status ${made.status ?? "unknown"}). Nothing was published.`;
  const again = resolveTag(repo, tag, api);
  if (again.error) return again.error;
  if (again.commit === undefined) return `${tag} is still missing after it was created.`;
  return again.commit === target ? null : `${tag} points at ${again.commit} after it was created, not at the build commit ${target}.`;
}

export function main(argv, run = (args) => execFileSync("gh", args, { stdio: "inherit" }), api = ghApi) {
  let args;
  let opts;
  try {
    opts = parseArgs(argv);
    args = engineReleaseArgs(opts.tag, opts.files, { target: opts.target, repo: opts.repo });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const repo = opts.repo ?? "seira-bot/seira";
  const problem = ensureTagProtection(repo, opts.tag, api) ?? ensureTag(repo, opts.tag, opts.target, api);
  if (problem) {
    console.error(problem);
    return 1;
  }
  try {
    run(args);
  } catch {
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
