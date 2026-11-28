import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { advisoryPatched, judgeBlockers, releaseBlockers, versionCovers } from "./release-blockers.mjs";

interface Advisory {
  ghsa_id: string;
  severity: string;
  description?: string;
  summary?: string;
  vulnerabilities?: { patched_versions?: string | null }[];
}

interface World {
  issues?: object[];
  draft?: Advisory[];
  triage?: Advisory[];
  fail?: "issues" | "advisories";
}

const advisory = (id: string, severity: string, patched: string | null | undefined = undefined, extra: Partial<Advisory> = {}): Advisory => ({
  ghsa_id: id,
  severity,
  description: "SECRET DETAILS OF THE FLAW",
  summary: "SECRET SUMMARY",
  vulnerabilities: [{ patched_versions: patched }],
  ...extra,
});

const run = async (world: World, version = "1.2.0") => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    const page = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
    const slice = (items: object[]) => items.slice((page - 1) * 100, page * 100);
    if (path.includes("/issues?")) {
      if (world.fail === "issues") throw new Error("HTTP 500");
      return slice(world.issues ?? []);
    }
    if (path.includes("state=draft")) {
      if (world.fail === "advisories") throw new Error("HTTP 403");
      return slice(world.draft ?? []);
    }
    if (path.includes("state=triage")) return slice(world.triage ?? []);
    throw new Error(`unexpected api call ${path}`);
  };
  const out: string[] = [];
  const code = await releaseBlockers({ api, repo: "o/r", version, log: (line: string) => out.push(line) });
  return { code, out: out.join("\n"), calls };
};

describe("release blockers", () => {
  it("passes when nothing blocks the release (exit 0)", async () => {
    const result = await run({});
    expect(result.code).toBe(0);
    expect(result.out).toContain("ok");
    expect(result.out).not.toContain("FAIL");
  });

  it("asks only for open issues with the P0 label", async () => {
    const result = await run({});
    expect(result.calls.some((call) => call.startsWith("repos/o/r/issues?state=open&labels=P0&"))).toBe(true);
  });

  it("blocks on an open P0 issue (exit 1)", async () => {
    const result = await run({ issues: [{ number: 7 }] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("issue #7");
    expect(result.out).toContain("Release 1.2.0 is blocked.");
  });

  it("does not count a pull request that carries the P0 label", async () => {
    const result = await run({ issues: [{ number: 8, pull_request: { url: "x" } }] });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("#8");
  });

  it("blocks on a draft high advisory with no patched version (exit 1)", async () => {
    const result = await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high")] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("GHSA-aaaa-bbbb-cccc");
    expect(result.out).toContain("high");
  });

  it("blocks on a triage critical advisory whose patch is newer than the release", async () => {
    const result = await run({ triage: [advisory("GHSA-1111-2222-3333", "critical", "1.3.0")] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("critical");
  });

  it("blocks when only one of two vulnerabilities has a covering patch", async () => {
    const mixed = advisory("GHSA-aaaa-bbbb-cccc", "high", null, { vulnerabilities: [{ patched_versions: "1.1.0" }, { patched_versions: null }] });
    expect((await run({ draft: [mixed] })).code).toBe(1);
  });

  it("passes a high advisory whose patched version covers the release version (exit 0)", async () => {
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", "1.2.0")] })).code).toBe(0);
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", "1.1.5")] })).code).toBe(0);
    expect((await run({ triage: [advisory("GHSA-aaaa-bbbb-cccc", "critical", ">= 1.0.0")] })).code).toBe(0);
  });

  it("passes a medium or low advisory with no patch", async () => {
    const result = await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "medium")], triage: [advisory("GHSA-dddd-eeee-ffff", "low")] });
    expect(result.code).toBe(0);
  });

  it("reads an advisory without a severity as not blocking", async () => {
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "")] })).code).toBe(0);
  });

  it("reads every page of a long list", async () => {
    const issues = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, pull_request: {} }));
    issues.push({ number: 500 } as never);
    const result = await run({ issues });
    expect(result.code).toBe(1);
    expect(result.out).toContain("issue #500");
  });

  it("prints the id and severity of an advisory, never its description", async () => {
    const result = await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high")], issues: [{ number: 3 }] });
    expect(result.out).not.toContain("SECRET");
  });

  it("throws on an API error, so the caller exits with 2", async () => {
    await expect(run({ fail: "issues" })).rejects.toThrow("HTTP 500");
    await expect(run({ fail: "advisories" })).rejects.toThrow("HTTP 403");
  });
});

describe("pure parts", () => {
  it.each([
    ["1.2.0", "1.2.0", true],
    [">= 1.2.0", "1.2.3", true],
    ["> 1.2.0", "1.2.0", false],
    ["= 1.2.0", "1.2.1", false],
    ["1.3.0", "1.2.9", false],
    ["< 2.0.0", "1.0.0", false],
    ["<= 2.0.0", "1.0.0", false],
    ["0.9.0, 1.5.0", "1.0.0", true],
    ["not a version", "1.0.0", false],
    [null, "1.0.0", false],
  ])("versionCovers(%s, %s): %s", (patched, version, expected) => {
    expect(versionCovers(patched as never, version)).toBe(expected);
  });

  it("needs a vulnerability to call an advisory patched", () => {
    expect(advisoryPatched({ vulnerabilities: [] }, "1.0.0")).toBe(false);
    expect(advisoryPatched({}, "1.0.0")).toBe(false);
  });

  it("ignores an advisory that is not draft or triage", () => {
    const lines = judgeBlockers({ issues: [], advisories: [{ ...advisory("GHSA-aaaa-bbbb-cccc", "high"), state: "published" }], version: "1.0.0" });
    expect(lines).toEqual([]);
  });
});

describe("command line", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  const cli = (args: string[], ghScript?: string) => {
    const folder = mkdtempSync(join(tmpdir(), "blockers-"));
    folders.push(folder);
    if (ghScript !== undefined) {
      writeFileSync(join(folder, "gh"), `#!/bin/sh\n${ghScript}\n`);
      chmodSync(join(folder, "gh"), 0o755);
    }
    const result = spawnSync("node", [new URL("./release-blockers.mjs", import.meta.url).pathname, ...args], {
      env: { PATH: `${folder}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r" },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it("exits 2 on a wrong argument", () => {
    for (const args of [[], ["--version"], ["--version", "1.2"], ["--version", "v1.2.3"], ["--version", "1.2.3", "--repo", "bad"], ["--version", "1.2.3", "--other"]]) {
      const result = cli(args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("Usage:");
    }
  });

  it("exits 2 when gh api fails", () => {
    const result = cli(["--version", "1.2.3"], 'echo "HTTP 502" >&2\nexit 1');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("HTTP 502");
  });

  it("exits 0 when gh api finds nothing", () => {
    const result = cli(["--version", "1.2.3"], "echo '[]'");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("exits 1 and names the issue when gh api finds a P0 issue", () => {
    const result = cli(["--version", "1.2.3"], `case "$2" in repos/o/r/issues*) echo '[{"number":42}]';; *) echo '[]';; esac`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("issue #42");
  });
});
