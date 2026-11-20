// The pre-push checks for a checkout without dependencies: send the pushed commits over ssh to a clone that has them,
// run scripts/pre-push-check.mjs there in a temporary worktree, and show its verdict. Only that script's own exit
// status 1 stops the push. An unreachable host, a missing clone or a timeout leave the push to CI.
// Settings, all from `git config`: seira.prePushHost (required), seira.prePushDir (the clone's folder under the home
// folder there; default: this clone's folder relative to the home folder here), seira.prePushWrap (a trusted command
// prefix for the check, for example a memory limit).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checksFor, pushedCommits } from "./pre-push-check.mjs";

const TIMEOUT_MS = 90_000;
const SHA = /^[0-9a-f]{40}$/;

export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/** The clone's folder relative to the home folder, or null when it is not under it. */
export function defaultDir(commonDir, home) {
  const path = relative(home, dirname(commonDir));
  return path === "" || path.startsWith("..") || isAbsolute(path) ? null : path;
}

/** The bash script that runs on the host: it reads the bundle from stdin, checks `sha` in a temporary worktree of the
 * clone at `dir` (under the home folder there) and removes everything it made. Exit 3 means it did not get to run, as when the commit has no scripts/pre-push-check.mjs. */
export function remoteScript({ dir, sha, wrap }) {
  if (!SHA.test(sha)) throw new Error("the commit is not a full sha");
  return [
    `repo="$HOME"/${shellQuote(dir)}`,
    `cd "$repo" || exit 3`,
    `root="\${XDG_CACHE_HOME:-$HOME/.cache}/seira-pre-push"`,
    `mkdir -p "$root" || exit 3`,
    `id="$(date +%s)-$$"; bundle="$root/$id.bundle"; wt="$root/$id"`,
    `cleanup() { cd "$repo" && git worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$wt" "$bundle"; git worktree prune >/dev/null 2>&1; }`,
    `trap 'cleanup; exit 3' INT TERM HUP`,
    `cat > "$bundle" || { cleanup; exit 3; }`,
    `git fetch -q origin main >/dev/null 2>&1`,
    `if [ -s "$bundle" ]; then git bundle unbundle "$bundle" >/dev/null 2>&1 || { cleanup; exit 3; }; fi`,
    `git worktree add -q --detach "$wt" ${sha} >/dev/null 2>&1 || { cleanup; exit 3; }`,
    `[ -f "$wt/scripts/pre-push-check.mjs" ] || { cleanup; exit 3; }`,
    `ln -s "$repo/node_modules" "$wt/node_modules" || { cleanup; exit 3; }`,
    `cd "$wt" && printf '%s\\n' 'pre-push ${sha} pre-push 0000000000000000000000000000000000000000' | ${wrap ? `${wrap} ` : ""}node scripts/pre-push-check.mjs`,
    `rc=$?; cleanup; exit $rc`,
  ].join("\n");
}

/** Exit status 1 is the check's own finding. Anything else, a signal included, says the check did not run. */
export function verdict(status, host, reason) {
  if (status === 0) return { block: false };
  if (status === 1) return { block: true };
  const why = reason ?? (status === null ? "it was stopped" : `exit status ${status}`);
  return { block: false, message: `pre-push: the check on ${host} did not run (${why}), so CI will check this push` };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const config = (key) => {
  try {
    return git("config", "--get", key).trim();
  } catch {
    return "";
  }
};

function main() {
  const started = Date.now();
  const head = git("rev-parse", "HEAD").trim();
  const shas = pushedCommits(readFileSync(0, "utf8"));
  const others = shas.filter((sha) => sha !== head);
  for (const sha of others) console.log(`pre-push: ${sha.slice(0, 9)} is not checked out here, so CI will check it`);
  if (!shas.includes(head)) return;

  const base = git("merge-base", "origin/main", head).trim();
  const files = git("diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", base, head).split("\0").filter(Boolean).filter((file) => existsSync(file));
  if (checksFor(files).length === 0) {
    console.log(`pre-push: ${files.length} changed file(s) checked in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return;
  }

  const host = config("seira.prePushHost");
  const dir = config("seira.prePushDir") || defaultDir(git("rev-parse", "--path-format=absolute", "--git-common-dir").trim(), homedir());
  if (!dir) {
    console.log("pre-push: this clone is not under the home folder and seira.prePushDir is not set, so CI will check this push");
    return;
  }
  const script = remoteScript({ dir, sha: head, wrap: config("seira.prePushWrap") });

  const tmp = mkdtempSync(join(tmpdir(), "seira-pre-push-"));
  try {
    let input = "";
    if (head !== base) {
      const bundle = join(tmp, "push.bundle");
      git("bundle", "create", bundle, "HEAD", `^${base}`);
      input = readFileSync(bundle);
    }
    const run = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `bash -lc ${shellQuote(script)}`], { input, stdio: ["pipe", "inherit", "inherit"], timeout: TIMEOUT_MS });
    const reason = run.error ? (run.error.code === "ETIMEDOUT" ? `past ${TIMEOUT_MS / 1000} s` : run.error.code) : undefined;
    const result = verdict(run.error ? null : run.status, host, reason);
    if (result.message) console.log(result.message);
    if (result.block) process.exitCode = 1;
    else if (!result.message) console.log(`pre-push: ${files.length} changed file(s) checked on ${host} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(`pre-push: could not read this push (${String(error.message).split("\n")[0]}), so CI will check it`);
  }
}
