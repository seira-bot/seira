import { describe, expect, it } from "vitest";

import { globToRegExp, humanApproved, isSensitivePath, parseArgs, parseReviewers, previousRelease, releaseGate, sensitiveFiles } from "./release-gate.mjs";

const sha = (n: number) => String(n).padStart(40, "0");
const TAG_SHA = sha(100);
const REPO = "o/r";

interface Pull {
  number: number;
  author_association: string;
  user: { login: string };
  merged_at: string | null;
  base: { ref: string };
  merge_commit_sha: string;
}

interface World {
  tagCommit?: string | null;
  mainStatus?: string;
  releases?: { tag_name: string; draft: boolean }[];
  rangeStatus?: string;
  commits?: string[];
  pulls?: Record<string, Pull[]>;
  files?: Record<number, { filename: string; previous_filename?: string }[]>;
  reviews?: Record<number, { user: { login: string }; state: string }[]>;
}

const pull = (number: number, commit: string, extra: Partial<Pull> = {}): Pull => ({
  number,
  author_association: "MEMBER",
  user: { login: "dev" },
  merged_at: "2026-11-20T10:00:00Z",
  base: { ref: "main" },
  merge_commit_sha: commit,
  ...extra,
});

function fake(world: World) {
  const calls: string[] = [];
  const commits = world.commits ?? [sha(1)];
  const api = async (path: string) => {
    calls.push(path);
    let match: RegExpExecArray | null;
    if ((match = /^repos\/o\/r\/git\/ref\/tags\/(.+)$/.exec(path))) {
      if (world.tagCommit === null) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { object: { type: "commit", sha: world.tagCommit ?? TAG_SHA } };
    }
    if (/\/compare\/[0-9a-f]{40}\.\.\.main$/.test(path)) return { status: world.mainStatus ?? "ahead" };
    if (path.startsWith("repos/o/r/releases?")) {
      const page = Number(/&page=(\d+)/.exec(path)![1]);
      return page === 1 ? (world.releases ?? [{ tag_name: "v1.0.0", draft: false }]) : [];
    }
    if ((match = /\/compare\/(v[\d.]+)\.\.\.[0-9a-f]{40}\?per_page=(\d+)&page=(\d+)/.exec(path))) {
      const perPage = Number(match[2]);
      const page = Number(match[3]);
      return {
        status: world.rangeStatus ?? "ahead",
        total_commits: commits.length,
        commits: commits.slice((page - 1) * perPage, page * perPage).map((each) => ({ sha: each })),
      };
    }
    if ((match = /\/commits\/([0-9a-f]{40})\/pulls/.exec(path))) return world.pulls?.[match[1]!] ?? [pull(Number(match[1]), match[1]!)];
    if ((match = /\/pulls\/(\d+)\/files\?/.exec(path))) return world.files?.[Number(match[1])] ?? [{ filename: "src/a.ts" }];
    if ((match = /\/pulls\/(\d+)\/reviews\?/.exec(path))) return world.reviews?.[Number(match[1])] ?? [];
    throw new Error(`unexpected api call ${path}`);
  };
  return { api, calls };
}

const run = async (world: World, extra: { reviewers?: string; sha?: string } = {}) => {
  const { api, calls } = fake(world);
  const out: string[] = [];
  const summaries: string[] = [];
  const code = await releaseGate({ api, repo: REPO, tag: extra.sha ? null : "v1.1.0", sha: extra.sha ?? null, reviewers: extra.reviewers, log: (line) => out.push(line), summary: (text) => summaries.push(text) });
  return { code, out: out.join("\n"), calls, summaries };
};

describe("release gate", () => {
  it("passes a run whose commits all come from member pull requests on safe paths (exit 0)", async () => {
    const result = await run({ commits: [sha(1), sha(2)] });
    expect(result.code).toBe(0);
    expect(result.out).toContain("pull request #1 passes");
    expect(result.out).not.toContain("FLAG");
    expect(result.summaries[0]).toContain("Release gate");
  });

  it("refuses a tag commit that is not on main (exit 2)", async () => {
    for (const mainStatus of ["diverged", "behind"]) {
      const result = await run({ mainStatus });
      expect(result.code, mainStatus).toBe(2);
      expect(result.out).toContain("FAIL");
    }
  });

  it("refuses a tag that does not exist (exit 2)", async () => {
    expect((await run({ tagCommit: null })).code).toBe(2);
  });

  it("flags an author who is not an owner or member (exit 1)", async () => {
    const result = await run({ pulls: { [sha(1)]: [pull(1, sha(1), { author_association: "CONTRIBUTOR", user: { login: "out" } })] } });
    expect(result.code).toBe(1);
    expect(result.out).toContain("FLAG");
    expect(result.out).toContain("out");
  });

  it("accepts an outside author after a listed human approved (exit 0)", async () => {
    const world: World = {
      pulls: { [sha(1)]: [pull(1, sha(1), { author_association: "CONTRIBUTOR" })] },
      reviews: { 1: [{ user: { login: "Boss" }, state: "APPROVED" }] },
    };
    expect((await run(world, { reviewers: '["boss"]' })).code).toBe(0);
    expect((await run(world, { reviewers: '["someone"]' })).code).toBe(1);
  });

  it("flags a sensitive path, also a rename away from one (exit 1)", async () => {
    for (const files of [[{ filename: ".github/workflows/x.yml" }], [{ filename: "docs/x.md", previous_filename: "scripts/release-gate.mjs" }]]) {
      const result = await run({ files: { 1: files } });
      expect(result.code).toBe(1);
      expect(result.out).toContain("sensitive path");
    }
  });

  it("accepts a sensitive path after a listed human approved (exit 0)", async () => {
    const result = await run({ files: { 1: [{ filename: ".npmrc" }] }, reviews: { 1: [{ user: { login: "boss" }, state: "APPROVED" }] } }, { reviewers: '["boss"]' });
    expect(result.code).toBe(0);
  });

  it("flags a commit without a merged pull request (exit 1)", async () => {
    const other = [pull(1, sha(9))];
    const unmerged = [pull(1, sha(1), { merged_at: null })];
    const wrongBase = [pull(1, sha(1), { base: { ref: "dev" } })];
    for (const list of [[], other, unmerged, wrongBase]) {
      const result = await run({ pulls: { [sha(1)]: list } });
      expect(result.code).toBe(1);
      expect(result.out).toContain("without a merged pull request");
    }
  });

  it("flags a human review that changed to CHANGES_REQUESTED after an approval (exit 1)", async () => {
    const result = await run(
      {
        files: { 1: [{ filename: ".github/x" }] },
        reviews: { 1: [{ user: { login: "boss" }, state: "APPROVED" }, { user: { login: "boss" }, state: "CHANGES_REQUESTED" }] },
      },
      { reviewers: '["boss"]' },
    );
    expect(result.code).toBe(1);
  });

  it("flags a run with no previous published release (exit 1)", async () => {
    const result = await run({ releases: [{ tag_name: "v1.0.0", draft: true }] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("no previous published release");
  });

  it("flags a range that is behind or diverged (exit 1)", async () => {
    expect((await run({ rangeStatus: "diverged" })).code).toBe(1);
  });

  it("reads every page of the commits in the range", async () => {
    const commits = Array.from({ length: 230 }, (_, i) => sha(i + 1));
    const result = await run({ commits });
    expect(result.code).toBe(0);
    expect(result.calls.filter((call) => call.includes("/compare/v1.0.0...")).length).toBe(3);
    expect(result.calls.filter((call) => /\/commits\/[0-9a-f]{40}\/pulls/.test(call))).toHaveLength(230);
  });

  it("treats an invalid RELEASE_HUMAN_REVIEWERS as an empty list", async () => {
    const world: World = {
      pulls: { [sha(1)]: [pull(1, sha(1), { author_association: "NONE" })] },
      reviews: { 1: [{ user: { login: "boss" }, state: "APPROVED" }] },
    };
    for (const reviewers of ["boss", '"boss"', "{", '{"a":1}']) {
      const result = await run(world, { reviewers });
      expect(result.code, reviewers).toBe(1);
    }
  });

  it("works with a sha and takes the highest published release as the previous one", async () => {
    const result = await run({ releases: [{ tag_name: "v1.0.0", draft: false }, { tag_name: "v2.0.0", draft: false }] }, { sha: sha(50) });
    expect(result.code).toBe(0);
    expect(result.calls.some((call) => call.includes("/compare/v2.0.0..."))).toBe(true);
  });

  it("lets an API error reach the caller", async () => {
    await expect(releaseGate({ api: async () => { throw new Error("boom"); }, repo: REPO, tag: "v1.1.0", log: () => {} })).rejects.toThrow("boom");
  });
});

describe("pure parts", () => {
  it.each([
    [".github/workflows/ci.yml", true],
    [".github/CODEOWNERS", true],
    ["scripts/release-gate.mjs", true],
    ["scripts/release-preflight.test.ts", true],
    ["scripts/git-hooks/pre-push", true],
    ["scripts/releasing.mjs", false],
    ["pnpm-workspace.yaml", true],
    [".npmrc", true],
    ["packages/a/.npmrc", true],
    ["docs/.github/x", false],
    ["src/npmrc", false],
    ["scripts/ci.mjs", false],
  ])("matches %s: %s", (path, expected) => {
    expect(isSensitivePath(path)).toBe(expected);
  });

  it("matches a glob without a new dependency", () => {
    expect(globToRegExp("a/*.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
    expect(globToRegExp("a/**").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a.c").test("abc")).toBe(false);
  });

  it("reads both names of a rename", () => {
    expect(sensitiveFiles([{ filename: "a.ts" }, { filename: "b", previous_filename: ".npmrc" }])).toEqual([".npmrc"]);
  });

  it("picks the highest published tag below the current one", () => {
    const releases = [
      { tag_name: "v0.1.9", draft: false },
      { tag_name: "v0.1.10", draft: false },
      { tag_name: "v0.1.11", draft: true },
      { tag_name: "v0.1.12", draft: false },
      { tag_name: "nightly", draft: false },
    ];
    expect(previousRelease(releases, "v0.1.12")).toBe("v0.1.10");
    expect(previousRelease(releases, "v0.1.9")).toBeNull();
    expect(previousRelease(releases)).toBe("v0.1.12");
  });

  it("ignores a comment after an approval and keeps the latest real review", () => {
    const review = (state: string) => ({ user: { login: "Boss" }, state });
    expect(humanApproved([review("APPROVED"), review("COMMENTED")], ["boss"])).toBe(true);
    expect(humanApproved([review("APPROVED"), review("DISMISSED")], ["boss"])).toBe(false);
    expect(humanApproved([review("APPROVED")], [])).toBe(false);
  });

  it("parses the reviewer list", () => {
    expect(parseReviewers('["A","b"]')).toEqual({ logins: ["a", "b"], valid: true });
    expect(parseReviewers(undefined)).toEqual({ logins: [], valid: true });
    expect(parseReviewers("x")).toEqual({ logins: [], valid: false });
  });

  it("reads the arguments", () => {
    expect(parseArgs(["--tag", "v1.2.3", "--repo", "a/b"])).toMatchObject({ tag: "v1.2.3", repo: "a/b" });
    expect(parseArgs(["--sha", sha(1)]).sha).toBe(sha(1));
    for (const argv of [[], ["--tag", "1.2.3"], ["--tag", "v1.2.3", "--sha", sha(1)], ["--sha", "abc"], ["--nope"]]) {
      expect(() => parseArgs(argv)).toThrowError(expect.objectContaining({ exitCode: 2 }));
    }
  });
});
