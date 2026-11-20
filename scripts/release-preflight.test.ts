import { describe, expect, it } from "vitest";

import { ciProof, judgeChecks, mainVerdict, newestByName, parseArgs, preflight, repoFromRemote } from "./release-preflight.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const TREE = "c".repeat(40);

const run = (name: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({
  id: 1,
  name,
  status: conclusion === null ? "queued" : "completed",
  conclusion,
  started_at: "2026-11-20T10:00:00Z",
  html_url: `https://example.test/${name}`,
  ...extra,
});
const ciRun = (conclusion: string, event: string, tree = TREE, id = 9) => ({
  id,
  event,
  conclusion,
  status: "completed",
  head_sha: OTHER,
  head_commit: { tree_id: tree },
  html_url: `https://example.test/runs/${id}`,
});

describe("parseArgs", () => {
  it("reads a tag, a sha with a version, and the repository", () => {
    expect(parseArgs(["--tag", "v0.1.2"]).tag).toBe("v0.1.2");
    expect(parseArgs(["--sha", SHA, "--version", "0.1.2", "--repo", "a/b"])).toMatchObject({ sha: SHA, version: "0.1.2", repo: "a/b" });
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it.each([
    [[]],
    [["--tag", "v0.1.2", "--sha", SHA]],
    [["--tag", "0.1.2"]],
    [["--sha", "abc"]],
    [["--tag"]],
    [["--tag", "v0.1.2", "--version", "0.1.2"]],
    [["--sha", SHA, "--version", "x"]],
    [["--nope"]],
  ])("gives exit 2 for %j", (argv) => {
    expect(() => parseArgs(argv)).toThrowError(expect.objectContaining({ exitCode: 2 }));
  });
});

describe("repoFromRemote", () => {
  it.each([
    "https://github.com/o/r.git",
    "https://github.com/o/r",
    "git@github.com:o/r.git",
    "git@github.com:o/r",
    "ssh://git@github.com/o/r.git",
  ])("reads %s", (url) => {
    expect(repoFromRemote(url)).toBe("o/r");
  });

  it("gives null for another host", () => {
    expect(repoFromRemote("https://example.test/o/r.git")).toBeNull();
  });
});

describe("judgeChecks", () => {
  it("keeps only the newest run of a name", () => {
    const older = run("build", "failure", { id: 1, started_at: "2026-11-20T09:00:00Z" });
    const newer = run("build", "success", { id: 2, started_at: "2026-11-20T10:00:00Z" });
    expect(newestByName([newer, older])).toEqual([newer]);
    const result = judgeChecks([older, newer]);
    expect(result.failures).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  it("breaks a tie on the time by the id", () => {
    const a = run("build", "failure", { id: 1 });
    const b = run("build", "success", { id: 2 });
    expect(newestByName([a, b])).toEqual([b]);
  });

  it("passes success, skipped and neutral", () => {
    const result = judgeChecks([run("a", "success"), run("b", "skipped", { id: 2 }), run("c", "neutral", { id: 3 })]);
    expect(result).toEqual({ failures: [], pending: [], superseded: [] });
  });

  it("fails a queued or running check as pending", () => {
    const result = judgeChecks([run("a", null), { ...run("b", null, { id: 2 }), status: "in_progress" }]);
    expect(result.pending.map((item) => item.name)).toEqual(["a", "b"]);
  });

  it.each(["failure", "timed_out", "action_required", "startup_failure", "stale"])("fails a %s check", (conclusion) => {
    expect(judgeChecks([run("a", conclusion)]).failures[0]).toMatchObject({ name: "a", state: conclusion });
  });

  it("calls a cancelled check superseded, not a failure", () => {
    const result = judgeChecks([run("a", "cancelled")]);
    expect(result.superseded.map((item) => item.name)).toEqual(["a"]);
    expect(result.failures).toEqual([]);
  });

  it("fails a failure status and holds a pending one", () => {
    const result = judgeChecks([], [
      { context: "deploy", state: "failure", id: 1, target_url: "https://example.test/d" },
      { context: "lint", state: "pending", id: 2 },
      { context: "ok", state: "success", id: 3 },
    ]);
    expect(result.failures.map((item) => item.name)).toEqual(["deploy"]);
    expect(result.pending.map((item) => item.name)).toEqual(["lint"]);
  });

  it("uses the newest status of a context", () => {
    const result = judgeChecks([], [
      { context: "x", state: "failure", id: 1, updated_at: "2026-11-20T09:00:00Z" },
      { context: "x", state: "success", id: 2, updated_at: "2026-11-20T10:00:00Z" },
    ]);
    expect(result.failures).toEqual([]);
  });
});

describe("ciProof", () => {
  it("accepts a successful CI check on the commit", () => {
    expect(ciProof({ checkRuns: [run("CI", "success")], runs: [], tree: TREE })).toMatchObject({ url: "https://example.test/CI" });
  });

  it("accepts a manual run with the same tree when CI was cancelled", () => {
    const proof = ciProof({ checkRuns: [run("CI", "cancelled")], runs: [ciRun("success", "workflow_dispatch", TREE, 77)], tree: TREE });
    expect(proof?.how).toContain("77");
    expect(proof?.how).toContain("workflow_dispatch");
  });

  it("accepts a push and a merge group run", () => {
    expect(ciProof({ checkRuns: [], runs: [ciRun("success", "push")], tree: TREE })).not.toBeNull();
    expect(ciProof({ checkRuns: [], runs: [ciRun("success", "merge_group")], tree: TREE })).not.toBeNull();
  });

  it("does not accept a pull request run", () => {
    expect(ciProof({ checkRuns: [run("CI", "cancelled")], runs: [ciRun("success", "pull_request")], tree: TREE })).toBeNull();
  });

  it("does not accept a run with another tree", () => {
    expect(ciProof({ checkRuns: [], runs: [ciRun("success", "push", "d".repeat(40))], tree: TREE })).toBeNull();
  });

  it("does not accept a CI check that failed", () => {
    expect(ciProof({ checkRuns: [run("CI", "failure")], runs: [], tree: TREE })).toBeNull();
  });
});

describe("mainVerdict", () => {
  it("fails when the newest finished run failed after an older success", () => {
    const verdict = mainVerdict([ciRun("failure", "push", TREE, 2), ciRun("success", "push", TREE, 1)]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("failure");
  });

  it("skips a cancelled run and uses the next one", () => {
    expect(mainVerdict([ciRun("cancelled", "push", TREE, 2), ciRun("success", "push", TREE, 1)]).ok).toBe(true);
  });

  it("fails when there is no finished run", () => {
    expect(mainVerdict([ciRun("cancelled", "push")]).ok).toBe(false);
    expect(mainVerdict([]).ok).toBe(false);
  });
});

type Fixture = {
  version?: string;
  tagRef?: { type: string; sha: string } | null;
  compare?: string;
  checkRuns?: unknown[];
  statuses?: unknown[];
  successRuns?: unknown[];
  mainRuns?: unknown[];
};

function stub(fixture: Fixture = {}) {
  const f = {
    version: "0.1.3",
    tagRef: null,
    compare: "identical",
    checkRuns: [run("CI", "success"), run("build", "success", { id: 2 })],
    statuses: [],
    successRuns: [],
    mainRuns: [ciRun("success", "push", TREE, 5)],
    ...fixture,
  };
  return async (path: string) => {
    const notFound = Object.assign(new Error("HTTP 404"), { status: 404 });
    if (path.includes("/commits/") && path.includes("/check-runs")) return { total_count: f.checkRuns.length, check_runs: f.checkRuns };
    if (path.includes("/commits/") && path.includes("/status")) return { statuses: f.statuses };
    if (path.includes("/commits/")) return { sha: SHA, commit: { tree: { sha: TREE } } };
    if (path.includes("/contents/package.json")) return { content: Buffer.from(JSON.stringify({ version: f.version })).toString("base64") };
    if (path.includes("/git/ref/tags/")) {
      if (!f.tagRef) throw notFound;
      return { object: f.tagRef };
    }
    if (path.includes("/git/tags/")) return { object: { type: "commit", sha: OTHER } };
    if (path.includes("/compare/")) return { status: f.compare };
    if (path.includes("status=success")) return { workflow_runs: f.successRuns };
    if (path.includes("branch=main")) return { workflow_runs: f.mainRuns };
    throw new Error(`unexpected path ${path}`);
  };
}

async function runPreflight(fixture: Fixture, input: { tag?: string; sha?: string; version?: string }) {
  const lines: string[] = [];
  const code = await preflight({ api: stub(fixture), repo: "o/r", ...input, log: (line: string) => lines.push(line) });
  return { code, text: lines.join("\n") };
}

describe("preflight", () => {
  it("exits 0 and names the proving run when every check passes", async () => {
    const { code, text } = await runPreflight({}, { tag: "v0.1.3" });
    expect(code).toBe(0);
    expect(text).toContain("CI proof");
    expect(text).toContain("Preflight passed");
  });

  it("names a proving manual run when the CI check was cancelled", async () => {
    const { code, text } = await runPreflight({ checkRuns: [run("CI", "cancelled")], successRuns: [ciRun("success", "workflow_dispatch", TREE, 77)] }, { tag: "v0.1.3" });
    expect(code).toBe(0);
    expect(text).toContain("CI run 77");
  });

  it("exits 1 and prints the command to start CI when no run proves the tree", async () => {
    const { code, text } = await runPreflight({ checkRuns: [run("CI", "cancelled")], successRuns: [ciRun("success", "pull_request")] }, { tag: "v0.1.3" });
    expect(code).toBe(1);
    expect(text).toContain("gh workflow run ci.yml --ref v0.1.3");
  });

  it("reports every failure, not only the first", async () => {
    const { code, text } = await runPreflight(
      {
        version: "0.1.3",
        compare: "diverged",
        checkRuns: [run("CI", "success"), run("build", "failure", { id: 2 }), run("lint", null, { id: 3 })],
        statuses: [{ context: "deploy", state: "failure", id: 4 }],
        mainRuns: [ciRun("failure", "push")],
      },
      { tag: "v0.1.2" },
    );
    expect(code).toBe(1);
    expect(text.match(/^FAIL/gm)?.length).toBeGreaterThanOrEqual(6);
    expect(text).toContain("diverged");
    expect(text).toContain("build (failure)");
    expect(text).toContain("not finished: lint");
    expect(text).toContain("deploy (failure)");
  });

  it("fails when the tag and the package version differ", async () => {
    const { code, text } = await runPreflight({ version: "0.1.3" }, { tag: "v0.1.2" });
    expect(code).toBe(1);
    expect(text).toContain("tag v0.1.2 and package.json version 0.1.3");
  });

  it("fails with --sha when the requested version is not the package version", async () => {
    expect((await runPreflight({}, { sha: SHA, version: "0.1.4" })).code).toBe(1);
  });

  it("passes with --sha when the tag does not exist yet or points to the commit", async () => {
    expect((await runPreflight({}, { sha: SHA, version: "0.1.3" })).code).toBe(0);
    expect((await runPreflight({ tagRef: { type: "commit", sha: SHA } }, { sha: SHA })).code).toBe(0);
  });

  it("fails with --sha when the tag points elsewhere, also through an annotated tag", async () => {
    expect((await runPreflight({ tagRef: { type: "commit", sha: OTHER } }, { sha: SHA })).code).toBe(1);
    const annotated = await runPreflight({ tagRef: { type: "tag", sha: "e".repeat(40) } }, { sha: SHA });
    expect(annotated.code).toBe(1);
    expect(annotated.text).toContain(`points to ${OTHER}`);
  });

  it("fails when the commit is not on main", async () => {
    expect((await runPreflight({ compare: "diverged" }, { tag: "v0.1.3" })).code).toBe(1);
    expect((await runPreflight({ compare: "behind" }, { tag: "v0.1.3" })).code).toBe(1);
  });

  it("fails when main is red", async () => {
    const { code, text } = await runPreflight({ mainRuns: [ciRun("failure", "push", TREE, 2), ciRun("success", "push", TREE, 1)] }, { tag: "v0.1.3" });
    expect(code).toBe(1);
    expect(text).toContain("main");
  });

  it("passes when the newest main run was cancelled and the one before succeeded", async () => {
    expect((await runPreflight({ mainRuns: [ciRun("cancelled", "push", TREE, 2), ciRun("success", "push", TREE, 1)] }, { tag: "v0.1.3" })).code).toBe(0);
  });

  it("reads every page of check runs", async () => {
    const pages = [[run("a", "success")], [run("b", "failure", { id: 2 })]];
    const base = stub();
    const api = async (path: string) => {
      const page = /[?&]page=(\d+)/.exec(path);
      if (page) return { total_count: 2, check_runs: pages[Number(page[1]) - 1] };
      return base(path);
    };
    const lines: string[] = [];
    const code = await preflight({ api, repo: "o/r", tag: "v0.1.3", log: (line: string) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("b (failure)");
  });

  it("exits 1 when the tag does not exist", async () => {
    const api = async () => {
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    };
    expect(await preflight({ api, repo: "o/r", tag: "v9.9.9", log: () => {} })).toBe(1);
  });

  it("lets an API error other than 404 through", async () => {
    const api = async () => {
      throw Object.assign(new Error("HTTP 500"), { status: undefined });
    };
    await expect(preflight({ api, repo: "o/r", tag: "v0.1.3", log: () => {} })).rejects.toThrow("HTTP 500");
  });
});
