import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { advisoryBlock, judgeBlockers, rangeCovers, releaseBlockers, versionCovers } from "./release-blockers.mjs";

interface Advisory {
  ghsa_id: string;
  severity: string;
  description?: string;
  summary?: string;
  vulnerabilities?: { patched_versions?: string | null; vulnerable_version_range?: string | null }[];
}

interface World {
  issues?: object[];
  draft?: Advisory[];
  triage?: Advisory[];
  fail?: "issues" | "advisories";
}

const advisory = (
  id: string,
  severity: string,
  patched: string | null | undefined = undefined,
  extra: Partial<Advisory> = {},
  range: string | null = ">= 1.0.0",
): Advisory => ({
  ghsa_id: id,
  severity,
  description: "SECRET DETAILS OF THE FLAW",
  summary: "SECRET SUMMARY",
  vulnerabilities: [{ patched_versions: patched, vulnerable_version_range: range }],
  ...extra,
});

const run = async (world: World, version = "1.2.0", details = false) => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    const page = Number(/[&?]page=(\d+)/.exec(path)?.[1] ?? 1);
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
  const code = await releaseBlockers({ api, repo: "o/r", version, details, log: (line: string) => out.push(line) });
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
    expect(result.out).toContain("FAIL 1 security advisory blocks release 1.2.0.");
    expect(result.out).toContain("Release 1.2.0 is blocked.");
  });

  it("blocks on a triage critical advisory whose patch is newer than the release", async () => {
    const result = await run({ triage: [advisory("GHSA-1111-2222-3333", "critical", "1.3.0")] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL 1 security advisory blocks");
  });

  it("counts every blocking advisory", async () => {
    const result = await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high")], triage: [advisory("GHSA-1111-2222-3333", "critical")] });
    expect(result.out).toContain("FAIL 2 security advisories block release 1.2.0.");
  });

  it("blocks when only one of two vulnerabilities has a covering patch", async () => {
    const mixed = advisory("GHSA-aaaa-bbbb-cccc", "high", null, {
      vulnerabilities: [
        { patched_versions: "1.1.0", vulnerable_version_range: ">= 1.0.0" },
        { patched_versions: null, vulnerable_version_range: ">= 1.0.0" },
      ],
    });
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

  it("prints no advisory id, severity, state or description without --details", async () => {
    const worlds: World[] = [
      { draft: [advisory("GHSA-aaaa-bbbb-cccc", "high")], issues: [{ number: 3 }] },
      { triage: [advisory("GHSA-1111-2222-3333", "critical", "1.3.0")] },
      { draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", null, {}, "free text")] },
      { draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", null, { vulnerabilities: [] })] },
    ];
    for (const world of worlds) {
      const result = await run(world);
      expect(result.code).toBe(1);
      expect(result.out).not.toMatch(/GHSA-|SECRET|high|critical|draft|triage/);
    }
  });

  it("prints the id, severity, state and reason with --details, never the description", async () => {
    const result = await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high")], triage: [advisory("GHSA-1111-2222-3333", "critical", null, {}, "free text")] }, "1.2.0", true);
    expect(result.out).toContain("advisory GHSA-aaaa-bbbb-cccc (high, draft) affects 1.2.0 and has no patched version that covers it");
    expect(result.out).toContain("advisory GHSA-1111-2222-3333 (critical, triage) has no version range that shows 1.2.0 is safe");
    expect(result.out).not.toContain("SECRET");
  });

  it("blocks on an open-ended range that covers the release", async () => {
    const result = await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", null, {}, ">= 0.1.170")] }, "0.1.197", true);
    expect(result.code).toBe(1);
    expect(result.out).toContain("advisory GHSA-aaaa-bbbb-cccc (high, draft) affects 0.1.197");
  });

  it("passes a closed range that ends below the release", async () => {
    const result = await run({ triage: [advisory("GHSA-aaaa-bbbb-cccc", "critical", null, {}, ">= 0.1.170, <= 0.1.194")] }, "0.1.197");
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("GHSA-aaaa-bbbb-cccc");
  });

  it("passes a range that names one older version", async () => {
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", null, {}, "0.1.196")] }, "0.1.197")).code).toBe(0);
  });

  it("blocks when the range does not parse or is missing", async () => {
    for (const range of ["Post-merge main at 5cafcf8e", "", null]) {
      const result = await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", null, {}, range)] }, "0.1.197", true);
      expect(result.code, String(range)).toBe(1);
      expect(result.out).toContain("advisory GHSA-aaaa-bbbb-cccc (high, draft) has no version range that shows 0.1.197 is safe");
    }
  });

  it("blocks when an advisory names no vulnerability", async () => {
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", null, { vulnerabilities: [] })] })).code).toBe(1);
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", null, { vulnerabilities: undefined })] })).code).toBe(1);
  });

  it("does not block on an unknown range of a medium or low advisory", async () => {
    for (const severity of ["medium", "low", ""]) {
      expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", severity, null, {}, "free text")] })).code, severity).toBe(0);
    }
  });

  it("passes a range that does not parse when the patched version covers the release", async () => {
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", "1.0.0", {}, "free text")] })).code).toBe(0);
  });

  it("passes an open-ended range when the patched version covers the release", async () => {
    expect((await run({ draft: [advisory("GHSA-aaaa-bbbb-cccc", "high", "0.1.197", {}, ">= 0.1.170")] }, "0.1.197")).code).toBe(0);
  });

  it("blocks when one vulnerability blocks and another does not parse", async () => {
    const mixed = advisory("GHSA-aaaa-bbbb-cccc", "high", null, {
      vulnerabilities: [
        { patched_versions: null, vulnerable_version_range: "free text" },
        { patched_versions: null, vulnerable_version_range: "< 2.0.0" },
      ],
    });
    const result = await run({ draft: [mixed] }, "1.2.0", true);
    expect(result.code).toBe(1);
    expect(result.out).toContain("affects 1.2.0");
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

  it.each([
    [">= 0.1.170", "0.1.197", true],
    [">= 0.1.170, <= 0.1.194", "0.1.197", false],
    [">= 0.1.170, < 0.1.198", "0.1.197", true],
    ["0.1.196", "0.1.197", false],
    ["= 0.1.197", "0.1.197", true],
    ["> 0.1.197", "0.1.197", false],
    ["<= 0.1.197", "0.1.197", true],
    ["Post-merge main at 5cafcf8e", "0.1.197", null],
    [">= 0.1.170, later", "0.1.197", null],
    ["", "0.1.197", null],
    [null, "0.1.197", null],
  ])("rangeCovers(%s, %s): %s", (range, version, expected) => {
    expect(rangeCovers(range as never, version)).toBe(expected);
  });

  it("ignores an advisory that is not draft or triage", () => {
    const result = judgeBlockers({ issues: [], advisories: [{ ...advisory("GHSA-aaaa-bbbb-cccc", "high"), state: "published" }], version: "1.0.0" });
    expect(result).toEqual({ issues: [], advisories: [] });
  });

  it.each([
    [[{ vulnerable_version_range: ">= 1.0.0" }], "affected"],
    [[{ vulnerable_version_range: "< 1.0.0" }], null],
    [[{ vulnerable_version_range: "free text" }], "unknown"],
    [[{ vulnerable_version_range: "free text", patched_versions: "1.0.0" }], null],
    [[{ vulnerable_version_range: "free text" }, { vulnerable_version_range: ">= 1.0.0" }], "affected"],
    [[{ vulnerable_version_range: "free text" }, { vulnerable_version_range: "< 1.0.0" }], "unknown"],
    [[], "unknown"],
  ])("advisoryBlock(%j, 1.2.0): %s", (vulnerabilities, expected) => {
    expect(advisoryBlock({ vulnerabilities }, "1.2.0")).toBe(expected);
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

  const draftAdvisory = `case "$2" in repos/o/r/security-advisories?state=draft*) echo '[{"ghsa_id":"GHSA-xxxx-yyyy-zzzz","severity":"high","vulnerabilities":[]}]';; *) echo '[]';; esac`;

  it("exits 1 and prints only a count when gh api finds a blocking advisory", () => {
    const result = cli(["--version", "1.2.3"], draftAdvisory);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL 1 security advisory blocks release 1.2.3.");
    expect(result.stdout + result.stderr).not.toContain("GHSA-");
  });

  it("prints the advisory id with --details", () => {
    const result = cli(["--version", "1.2.3", "--details"], draftAdvisory);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("advisory GHSA-xxxx-yyyy-zzzz (high, draft)");
  });

  it("is never called with --details from the public Release workflow", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("scripts/release-blockers.mjs");
    expect(workflow).not.toContain("--details");
  });
});
