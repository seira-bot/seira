import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../server/testing/cleanup.ts";
import { defaultDir, remoteScript, shellQuote, verdict } from "./pre-push-remote.mjs";

const SHA = "a".repeat(40);

describe("shellQuote", () => {
  it("wraps a text so a shell reads it back unchanged", () => {
    const text = "a b 'c' $HOME `id` \"d\"";
    expect(shellQuote(text)).toBe(`'a b '\\''c'\\'' $HOME \`id\` "d"'`);
    const unquoted = shellQuote(text).replaceAll("'\\''", "'").slice(1, -1);
    expect(unquoted).toBe(text);
  });
});

describe("remoteScript", () => {
  it("refuses a commit that is not a full sha", () => {
    expect(() => remoteScript({ dir: "Project/seira", sha: "abc; rm -rf /", wrap: "" })).toThrow();
    expect(() => remoteScript({ dir: "Project/seira", sha: "A".repeat(40), wrap: "" })).toThrow();
  });

  it("names the commit, the folder and the wrap prefix", () => {
    const script = remoteScript({ dir: "Project/my seira", sha: SHA, wrap: "systemd-run --scope" });
    expect(script).toContain(SHA);
    expect(script).toContain(`'Project/my seira'`);
    expect(script).toContain("systemd-run --scope node scripts/pre-push-check.mjs");
  });

  it("runs the check bare when no wrap is set", () => {
    expect(remoteScript({ dir: "x", sha: SHA, wrap: "" })).toContain("| node scripts/pre-push-check.mjs");
  });
});

describe("verdict", () => {
  it("blocks only on the check's own failure", () => {
    expect(verdict(1, "host")).toEqual({ block: true });
    expect(verdict(0, "host")).toEqual({ block: false });
  });

  it.each([2, 3, 255, null])("lets the push go on %s and says CI will check it", (status) => {
    const result = verdict(status, "host");
    expect(result.block).toBe(false);
    expect(result.message).toContain("CI will check this push");
  });
});

describe("defaultDir", () => {
  it("gives the folder relative to the home folder", () => {
    expect(defaultDir("/users/u/Project/seira/.git", "/users/u")).toBe("Project/seira");
  });

  it("gives null for a folder outside the home folder", () => {
    expect(defaultDir("/srv/seira/.git", "/users/u")).toBeNull();
    expect(defaultDir("/users/u/.git", "/users/u")).toBeNull();
  });
});

describe("the hook with a remote host", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs) await removeTempDir(dir); });

  function checkout(sshStatus: number) {
    const dir = mkdtempSync(join(tmpdir(), "seira-pre-push-remote-"));
    dirs.push(dir);
    const repo = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    const commit = (message: string) => repo("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", message);
    repo("init", "-q");
    commit("start");
    repo("update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "a.ts"), "export const a = 1;\n");
    repo("add", ".");
    commit("change");
    repo("config", "seira.prePushHost", "fakehost");
    repo("config", "seira.prePushDir", "clone");
    mkdirSync(join(dir, "hooks"));
    mkdirSync(join(dir, "scripts"));
    for (const [from, to] of [["git-hooks/pre-push", "hooks/pre-push"], ["pre-push-check.mjs", "scripts/pre-push-check.mjs"], ["pre-push-remote.mjs", "scripts/pre-push-remote.mjs"]]) {
      copyFileSync(fileURLToPath(new URL(`./${from}`, import.meta.url)), join(dir, to));
    }
    chmodSync(join(dir, "hooks", "pre-push"), 0o755);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "ssh"), `#!/bin/sh\ncat >/dev/null\nexit ${sshStatus}\n`);
    chmodSync(join(dir, "bin", "ssh"), 0o755);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    return { dir, sha, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } };
  }

  const push = ({ dir, sha, env }: ReturnType<typeof checkout>) =>
    spawnSync("sh", ["hooks/pre-push"], { cwd: dir, encoding: "utf8", env, timeout: 20_000, input: `refs/heads/x ${sha} refs/heads/x ${"0".repeat(40)}\n` });

  it.skipIf(process.platform === "win32")("lets the push go when the host cannot be reached", () => {
    const run = push(checkout(255));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("CI will check this push");
  });

  it.skipIf(process.platform === "win32")("stops the push when the check on the host fails", () => {
    expect(push(checkout(1)).status).toBe(1);
  });

  it.skipIf(process.platform === "win32")("lets the push go when the check passes", () => {
    const run = push(checkout(0));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("checked on fakehost");
  });
});
