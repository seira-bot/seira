// Creates the GitHub release for a Seira browser engine build, and never marks it Latest.
// releases/latest must stay the app release: deploy/install.sh, deploy/update.sh, server/update-check.ts and
// electron-updater (latest.yml) all read it. An engine release marked Latest breaks them.
// The release tag is made at the commit that built the binary (--target, 40 hex characters, required).
// An existing tag is never moved: if it points at another commit, the script stops.
// Exit status: 0 created, 1 `gh` failed or the tag is on another commit, 2 wrong use.
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
  return ["release", "create", tag, "--repo", repo, "--title", tag, "--target", target, "--latest=false", "--notes", `Seira browser engine build ${tag}, built from ${target}. Not an app release.`, "--", ...files];
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

/** Returns a reason when an existing tag points at a commit other than the build commit, else null. `lookup` returns the tag's commit or null. */
export function tagProblem(tag, target, lookup) {
  const at = lookup(tag);
  if (at === null || at === target) return null;
  return `${tag} already points at ${at}, not at the build commit ${target}. A tag is never moved. Record the real build commit in docs/browser-packaging.md.`;
}

function ghTagCommit(repo) {
  return (tag) => {
    try {
      return execFileSync("gh", ["api", `repos/${repo}/commits/${tag}`, "--jq", ".sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
}

export function main(argv, run = (args) => execFileSync("gh", args, { stdio: "inherit" }), lookup) {
  let args;
  let opts;
  try {
    opts = parseArgs(argv);
    args = engineReleaseArgs(opts.tag, opts.files, { target: opts.target, repo: opts.repo });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const problem = tagProblem(opts.tag, opts.target, lookup ?? ghTagCommit(opts.repo ?? "seira-bot/seira"));
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
