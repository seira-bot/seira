import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NPM_PACKAGE, baselineTag, globToRegExp, humanApproved, isSensitivePath, npmVersions, parseArgs, parseReviewers, releaseGate, sensitiveFiles } from "./release-gate.mjs";

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
  versions?: string[];
  registry?: "error" | "badjson";
  baselineMissing?: boolean;
  rangeStatus?: string;
  total?: number;
  changedFiles?: Record<number, number>;
  commits?: string[];
  pulls?: Record<string, Pull[]>;
  files?: Record<number, { filename: string; previous_filename?: string }[]>;
  reviews?: Record<number, { user: { login: string }; state: string; commit_id?: string }[]>;
}

const headOf = (number: number) => sha(5000 + number);

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
    if ((match = /\/compare\/(v[\d.]+)\.\.\.[0-9a-f]{40}\?per_page=(\d+)&page=(\d+)/.exec(path))) {
      if (world.baselineMissing) throw Object.assign(new Error("Not Found"), { status: 404 });
      const perPage = Number(match[2]);
      const page = Number(match[3]);
      return {
        status: world.rangeStatus ?? "ahead",
        total_commits: world.total ?? commits.length,
        commits: commits.slice((page - 1) * perPage, page * perPage).map((each) => ({ sha: each })),
      };
    }
    if ((match = /\/commits\/([0-9a-f]{40})\/pulls/.exec(path))) return world.pulls?.[match[1]!] ?? [pull(Number(match[1]), match[1]!)];
    if ((match = /\/pulls\/(\d+)\/files\?/.exec(path))) return world.files?.[Number(match[1])] ?? [{ filename: "src/a.ts" }];
    if ((match = /\/pulls\/(\d+)\/reviews\?/.exec(path))) {
      const number = Number(match[1]);
      return (world.reviews?.[number] ?? []).map((review) => ({ commit_id: headOf(number), ...review }));
    }
    if ((match = /^repos\/o\/r\/pulls\/(\d+)$/.exec(path))) {
      const number = Number(match[1]);
      return { head: { sha: headOf(number) }, changed_files: world.changedFiles?.[number] ?? (world.files?.[number] ?? [1]).length };
    }
    throw new Error(`unexpected api call ${path}`);
  };
  const fetched: string[] = [];
  const fetchJson = async (url: string) => {
    fetched.push(url);
    if (world.registry === "error") throw new Error("registry down");
    if (world.registry === "badjson") return "<html>";
    return { versions: Object.fromEntries((world.versions ?? ["1.0.0"]).map((version) => [version, {}])) };
  };
  return { api, fetchJson, calls, fetched };
}

const run = async (world: World, extra: { reviewers?: string; sha?: string; pinned?: string } = {}) => {
  const { api, fetchJson, calls, fetched } = fake(world);
  const out: string[] = [];
  const summaries: string[] = [];
  const code = await releaseGate({ api, fetchJson, repo: REPO, npmPackage: "@o/r", tag: extra.sha ? null : "v1.1.0", sha: extra.pinned ?? extra.sha ?? null, reviewers: extra.reviewers, log: (line) => out.push(line), summary: (text) => summaries.push(text) });
  return { code, out: out.join("\n"), calls, summaries, fetched };
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

  it("flags an approval of an older commit, and accepts an approval of the head commit", async () => {
    const world = (commit_id: string): World => ({
      files: { 1: [{ filename: ".github/x" }] },
      reviews: { 1: [{ user: { login: "boss" }, state: "APPROVED", commit_id }] },
    });
    expect((await run(world(sha(1)), { reviewers: '["boss"]' })).code).toBe(1);
    expect((await run(world(headOf(1)), { reviewers: '["boss"]' })).code).toBe(0);
  });

  it("flags a file list that the API cut short", async () => {
    const result = await run({ changedFiles: { 1: 3001 } });
    expect(result.code).toBe(1);
    expect(result.out).toContain("file list is incomplete");
  });

  it("flags a range with no commits", async () => {
    const result = await run({ commits: [] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("no commits since the previous release");
  });

  it("passes a run with a sha only on the commit of the last version on npm", async () => {
    const result = await run({ commits: [], rangeStatus: "identical" }, { sha: sha(50) });
    expect(result.code).toBe(0);
    expect(result.out).toContain("the last version on npm");
  });

  it("flags a commit list that is cut short", async () => {
    const result = await run({ commits: [sha(1)], total: 5 });
    expect(result.code).toBe(1);
    expect(result.out).toContain("cut short");
  });

  it("flags a run with no earlier version on npm (exit 1)", async () => {
    const result = await run({ versions: ["1.1.0", "2.0.0"] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("no earlier version");
  });

  it("reads the version list of the package from the npm registry, with the slash of a scoped name encoded", async () => {
    const result = await run({});
    expect(result.fetched).toEqual(["https://registry.npmjs.org/@o%2Fr"]);
    expect(result.calls.some((call) => call.includes("/contents/"))).toBe(false);
  });

  it("reads the baseline of the package that npm-publish.yml publishes", () => {
    const workflow = readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
    expect(NPM_PACKAGE).toBe("@seira-bot/seira");
    expect(workflow).toContain(`npm view "${NPM_PACKAGE}@$VERSION"`);
  });

  it("refuses a registry error or bad JSON (exit 2 through a thrown error)", async () => {
    await expect(run({ registry: "error" })).rejects.toThrow("registry down");
    await expect(run({ registry: "badjson" })).rejects.toThrow("no versions");
  });

  it("flags a baseline tag that does not exist", async () => {
    const result = await run({ baselineMissing: true });
    expect(result.code).toBe(1);
    expect(result.out).toContain("does not exist");
  });

  it("flags a baseline that is not an ancestor of the commit", async () => {
    for (const rangeStatus of ["behind", "diverged"]) {
      const result = await run({ rangeStatus });
      expect(result.code, rangeStatus).toBe(1);
      expect(result.out).toContain("not an ancestor");
    }
  });

  it("refuses a tag that does not point to the pinned commit (exit 2), and checks the pinned commit when it does", async () => {
    const refused = await run({}, { pinned: sha(7) });
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("FAIL");
    expect(refused.out).toContain("does not point to the commit");
    const accepted = await run({ tagCommit: sha(7) }, { pinned: sha(7) });
    expect(accepted.code).toBe(0);
    expect(accepted.calls.some((call) => call.includes(`...${sha(7)}?`))).toBe(true);
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

  it("works with a sha only and takes the highest version on npm as the baseline", async () => {
    const result = await run({ versions: ["1.0.0", "2.0.0", "3.0.0-beta.1"] }, { sha: sha(50) });
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

  it("picks the highest plain version below the current one", () => {
    const versions = ["0.1.9", "0.1.10", "0.1.12", "0.2.0-beta.1", "latest"];
    expect(baselineTag(versions, "v0.1.12")).toBe("v0.1.10");
    expect(baselineTag(versions, "v0.1.9")).toBeNull();
    expect(baselineTag(versions)).toBe("v0.1.12");
  });

  it("reads the versions of the registry answer", async () => {
    expect(await npmVersions(async () => ({ versions: { "1.0.0": {} } }), "pkg")).toEqual(["1.0.0"]);
    await expect(npmVersions(async () => ({}), "pkg")).rejects.toThrow();
  });

  it("ignores a comment after an approval and keeps the latest real review", () => {
    const review = (state: string, commit_id = "head") => ({ user: { login: "Boss" }, state, commit_id });
    expect(humanApproved([review("APPROVED"), review("COMMENTED")], ["boss"], "head")).toBe(true);
    expect(humanApproved([review("APPROVED"), review("DISMISSED")], ["boss"], "head")).toBe(false);
    expect(humanApproved([review("APPROVED")], [], "head")).toBe(false);
    expect(humanApproved([review("APPROVED", "old")], ["boss"], "head")).toBe(false);
    expect(humanApproved([review("APPROVED")], ["boss"], undefined)).toBe(false);
  });

  it("parses the reviewer list", () => {
    expect(parseReviewers('["A","b"]')).toEqual({ logins: ["a", "b"], valid: true });
    expect(parseReviewers(undefined)).toEqual({ logins: [], valid: true });
    expect(parseReviewers("x")).toEqual({ logins: [], valid: false });
  });

  it("reads the arguments", () => {
    expect(parseArgs(["--tag", "v1.2.3", "--repo", "a/b"])).toMatchObject({ tag: "v1.2.3", repo: "a/b" });
    expect(parseArgs(["--sha", sha(1)]).sha).toBe(sha(1));
    expect(parseArgs(["--tag", "v1.2.3", "--sha", sha(1)])).toMatchObject({ tag: "v1.2.3", sha: sha(1) });
    for (const argv of [[], ["--tag", "1.2.3"], ["--sha", "abc"], ["--nope"]]) {
      expect(() => parseArgs(argv)).toThrowError(expect.objectContaining({ exitCode: 2 }));
    }
  });
});
