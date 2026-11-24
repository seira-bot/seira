// Creates the GitHub release for a Seira browser engine build, and never marks it Latest.
// releases/latest must stay the app release: deploy/install.sh, deploy/update.sh, server/update-check.ts and
// electron-updater (latest.yml) all read it. An engine release marked Latest breaks them.
// Exit status: 0 created, 1 `gh` failed, 2 wrong use.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = /^browser-engine-v\d+\.\d+\.\d+-seira\.\d+$/;

export const USAGE = "Usage: node scripts/publish-browser-engine-release.mjs <browser-engine-vX.Y.Z-seira.N> <file>... [--repo <owner>/<name>]";

/** The `gh` arguments. `--latest=false` is always present. */
export function engineReleaseArgs(tag, files, repo = "seira-bot/seira") {
  if (!TAG.test(tag ?? "")) throw new Error("the tag must look like browser-engine-v0.36.0-seira.2");
  if (!files.length) throw new Error("give at least one file to upload");
  return ["release", "create", tag, ...files, "--repo", repo, "--title", tag, "--latest=false", "--notes", `Seira browser engine build ${tag}. Not an app release.`];
}

export function main(argv, run = (args) => execFileSync("gh", args, { stdio: "inherit" })) {
  const rest = [];
  let repo;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else rest.push(argv[i]);
  }
  let args;
  try {
    args = engineReleaseArgs(rest[0], rest.slice(1), repo);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    run(args);
  } catch {
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
