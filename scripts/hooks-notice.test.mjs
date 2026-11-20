import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOOKS_COMMAND, hooksAreActive, hooksNotice } from "./hooks-notice.mjs";

let root;
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hooks-notice-"));
  git("init", "-q");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("hooksNotice", () => {
  it("names the command when core.hooksPath is not set", () => {
    expect(hooksNotice(root, {})).toContain(HOOKS_COMMAND);
  });

  it("names the command when core.hooksPath points elsewhere", () => {
    git("config", "core.hooksPath", ".husky");
    expect(hooksNotice(root, {})).toContain(HOOKS_COMMAND);
  });

  it("is quiet when the repo hooks are active", () => {
    git("config", "core.hooksPath", "scripts/git-hooks");
    expect(hooksNotice(root, {})).toBeNull();
  });

  it("is quiet in CI and when hooks are skipped on purpose", () => {
    expect(hooksNotice(root, { CI: "true" })).toBeNull();
    expect(hooksNotice(root, { SEIRA_SKIP_HOOKS: "1" })).toBeNull();
  });
});

describe("hooksAreActive", () => {
  it("accepts the relative and the absolute path of the hooks folder", () => {
    expect(hooksAreActive("/repo", "scripts/git-hooks")).toBe(true);
    expect(hooksAreActive("/repo", "/repo/scripts/git-hooks")).toBe(true);
    expect(hooksAreActive("/repo", "")).toBe(false);
  });

  it("accepts the hooks folder of another checkout, as a git worktree has", () => {
    const other = join(root, "main-checkout", "scripts", "git-hooks");
    expect(hooksAreActive("/worktree", other, (path) => path === join(other, "pre-commit"))).toBe(true);
    expect(hooksAreActive("/worktree", other, () => false)).toBe(false);
    expect(hooksAreActive("/worktree", join(root, "my-scripts", "git-hooks"), () => true)).toBe(false);
  });
});
