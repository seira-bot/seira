import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../server/testing/cleanup.ts";
import { checksFor, pushedCommits } from "./pre-push-check.mjs";

const names = (files: string[]) => checksFor(files).map((check: { name: string }) => check.name);
const guards = (files: string[]) => checksFor(files).find((check: { name: string }) => check.name === "source guards")?.guards ?? [];

describe("what a push's changed files call for", () => {
  it("lints only the changed code", () => {
    const [lint] = checksFor(["server/a.ts", "docs/a.md", "src/b.tsx", "electron/c.mjs"]);
    expect(lint.args).toEqual(["--deny-warnings", "--no-error-on-unmatched-pattern", "server/a.ts", "src/b.tsx", "electron/c.mjs"]);
  });

  it("passes a push whose only code is a file the lint config ignores", () => {
    const [lint] = checksFor(["electron/vendor/electron-updater.cjs"]);
    const run = spawnSync(lint.command, lint.args, { encoding: "utf8" });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });

  it("checks nothing for docs alone", () => {
    expect(names(["README.md", "docs/ci.md"])).toEqual([]);
  });

  it("checks the catalogs only when one changed", () => {
    expect(names(["src/locales/de.json"])).toContain("locale catalogs");
    expect(names(["server/a.ts"])).not.toContain("locale catalogs");
  });

  it("runs a guard only when a source it reads changed", () => {
    expect(guards(["server/index.ts"])).toEqual(["scripts/testing/file-size-ratchet.test.ts", "src/locales/vocabulary.test.ts"]);
    expect(guards(["scripts/release-ci.mjs"])).toEqual(["scripts/testing/file-size-ratchet.test.ts"]);
    expect(guards(["src/locales/en.json"])).toEqual(["src/locales/vocabulary.test.ts"]);
    expect(guards(["server/a.test.ts", "server/testing/fake.ts"])).toEqual([]);
  });

  it("runs a fast Worker's tests when the push changes that Worker or a file it reads", () => {
    expect(names(["cloudflare/push-relay/src/x.ts"])).toContain("worker push-relay");
    expect(names(["shared/composio-storage.ts"])).toContain("worker composio-broker");
    expect(checksFor(["cloudflare/updates/src/x.ts"]).find((check: { worker?: string }) => check.worker)?.worker).toBe("updates");
  });

  it("runs no Worker's tests for a slow Worker or a shared input", () => {
    for (const file of ["cloudflare/control-plane/src/x.ts", "package.json", "docs/ci.md"]) {
      expect(names([file]).filter((name: string) => name.startsWith("worker "))).toEqual([]);
    }
  });

  it("reads the pushed commits, and a deleted branch sends none", () => {
    const sha = "a".repeat(40);
    expect(pushedCommits(`refs/heads/x ${sha} refs/heads/x ${"0".repeat(40)}\n`)).toEqual([sha]);
    expect(pushedCommits(`(delete) ${"0".repeat(40)} refs/heads/x ${sha}\n`)).toEqual([]);
    expect(pushedCommits("")).toEqual([]);
  });
});

describe("the hook in a checkout without dependencies", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs) await removeTempDir(dir); });

  function checkout() {
    const dir = mkdtempSync(join(tmpdir(), "seira-pre-push-hook-"));
    dirs.push(dir);
    const repo = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    repo("init", "-q");
    repo("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "start");
    mkdirSync(join(dir, "hooks"));
    const hook = join(dir, "hooks", "pre-push");
    copyFileSync(fileURLToPath(new URL("./git-hooks/pre-push", import.meta.url)), hook);
    chmodSync(hook, 0o755);
    return { dir, hook };
  }

  const run = ({ dir, hook }: { dir: string; hook: string }) => spawnSync(hook, { cwd: dir, encoding: "utf8", input: "", timeout: 10_000 });

  it.skipIf(process.platform === "win32")("stops the push and says no check ran when no host is set", () => {
    const result = run(checkout());
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no check ran");
    expect(result.stdout).toContain("seira.prePushHost");
  });

  it.skipIf(process.platform === "win32")("runs the remote script next to the hooks folder when the checkout has none", () => {
    const repo = checkout();
    execFileSync("git", ["config", "seira.prePushHost", "fakehost"], { cwd: repo.dir });
    writeFileSync(join(repo.dir, "pre-push-remote.mjs"), 'console.log("remote stub ran");\n');
    const result = run(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("remote stub ran");
  });

  it.skipIf(process.platform === "win32")("stops the push when a host is set and no remote script exists", () => {
    const repo = checkout();
    execFileSync("git", ["config", "seira.prePushHost", "fakehost"], { cwd: repo.dir });
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no check ran");
  });

  const without = (name: string) => Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== name));

  it.skipIf(process.platform === "win32")("stays out of the way when skipped", () => {
    const { dir, hook } = checkout();
    writeFileSync(join(dir, "ignored"), "");
    const env = { ...without("OMB_SKIP_HOOKS"), SEIRA_SKIP_HOOKS: "1" };
    const run = spawnSync(hook, { cwd: dir, encoding: "utf8", input: "", timeout: 10_000, env });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("skipped");
    expect(run.stdout).not.toContain("deprecated");
  });

  it.skipIf(process.platform === "win32")("still skips for the old name, and says it will be removed", () => {
    const { dir, hook } = checkout();
    writeFileSync(join(dir, "ignored"), "");
    const env = { ...without("SEIRA_SKIP_HOOKS"), OMB_SKIP_HOOKS: "1" };
    const run = spawnSync(hook, { cwd: dir, encoding: "utf8", input: "", timeout: 10_000, env });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("skipped");
    expect(run.stdout).toMatch(/OMB_SKIP_HOOKS.*deprecated.*removed/u);
  });

  it.skipIf(process.platform === "win32")("skips the commit hook for both names", () => {
    const { dir } = checkout();
    const hook = join(dir, "hooks", "pre-commit");
    copyFileSync(fileURLToPath(new URL("./git-hooks/pre-commit", import.meta.url)), hook);
    chmodSync(hook, 0o755);
    for (const [set, other] of [["SEIRA_SKIP_HOOKS", "OMB_SKIP_HOOKS"], ["OMB_SKIP_HOOKS", "SEIRA_SKIP_HOOKS"]] as const) {
      const run = spawnSync(hook, { cwd: dir, encoding: "utf8", timeout: 10_000, env: { ...without(other), [set]: "1" } });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`skipped (${set} is set`);
    }
  });
});
