// Tells a person or an agent that git does not run the repo hooks in this checkout. Needs only node and git.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const HOOKS_PATH = "scripts/git-hooks";
export const HOOKS_COMMAND = `git config core.hooksPath ${HOOKS_PATH}`;

export function hooksAreActive(root, configured) {
  return configured !== "" && resolve(root, configured) === resolve(root, HOOKS_PATH);
}

export function hooksNotice(root, env = process.env) {
  if (env.CI || env.SEIRA_SKIP_HOOKS) return null;
  let configured = "";
  try {
    configured = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
  }
  if (hooksAreActive(root, configured)) return null;
  return `The git hooks are off in this checkout, so a commit is not checked. Run once: ${HOOKS_COMMAND}`;
}

export function warnIfHooksOff(root, label) {
  const notice = hooksNotice(root);
  if (notice) console.error(`${label}: ${notice}`);
}
