import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NPM_PACKAGE, TRUSTED_AUTHORS_PATH, authorKind, baselineTag, globToRegExp, humanApproved, isSensitivePath, npmVersions, parseArgs, parseReviewers, parseTrustedAuthors, releaseGate, reviewerApproved, sensitiveFiles } from "./release-gate.mjs";

const sha = (n: number) => String(n).padStart(40, "0");
const TAG_SHA = sha(100);
const REPO = "o/r";

interface Account {
  login: string;
  id: number;
  type: string;
}

interface Pull {
  number: number;
  author_association: string;
  user: Account;
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
  reviews?: Record<number, { user: { login: string; id?: number; type?: string }; state: string; commit_id?: string }[]>;
  /** The review of the reviewer App. Default: an approval of the head commit. */
  reviewerReview?: "none" | "old" | "changes" | "wrongId" | "wrongType";
  /** The content of the trusted-author file on main, or "missing", "badjson", or "error". */
  trustedFile?: object | "missing" | "badjson" | "error";
  permission?: string | "error";
}

const LAGUS: Account = { login: "seira-lagus[bot]", id: 359729064, type: "Bot" };
const ROCTIS: Account = { login: "seira-roctis[bot]", id: 359729045, type: "Bot" };
const RAMA: Account = { login: "RamaAditya49", id: 213913142, type: "User" };
const OUTSIDER: Account = { login: "out", id: 1, type: "User" };
const entry = ({ login, id }: Account) => ({ login, id });
const TRUSTED = { version: 1, botAuthors: [entry(LAGUS), entry(ROCTIS)], adminAuthors: [entry(RAMA)], reviewerApps: [entry(ROCTIS)] };

const headOf = (number: number) => sha(5000 + number);

const pull = (number: number, commit: string, extra: Partial<Pull> = {}): Pull => ({
  number,
  author_association: "NONE",
  user: LAGUS,
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
      const mode = world.reviewerReview ?? "approved";
      const bot = mode === "wrongId" ? { ...ROCTIS, id: 999 } : mode === "wrongType" ? { ...ROCTIS, type: "User" } : ROCTIS;
      const own = mode === "none" ? [] : [{ user: bot, state: mode === "changes" ? "CHANGES_REQUESTED" : "APPROVED", commit_id: mode === "old" ? sha(1) : headOf(number) }];
      return [...own, ...(world.reviews?.[number] ?? [])].map((review) => ({ commit_id: headOf(number), ...review }));
    }
    if (path === `repos/o/r/contents/${TRUSTED_AUTHORS_PATH}?ref=main`) {
      if (world.trustedFile === "error") throw Object.assign(new Error("HTTP 502"), { status: 502 });
      if (world.trustedFile === "missing") throw Object.assign(new Error("Not Found"), { status: 404 });
      const text = world.trustedFile === "badjson" ? "{" : JSON.stringify(world.trustedFile ?? TRUSTED);
      return { encoding: "base64", content: Buffer.from(text).toString("base64") };
    }
    if ((match = /^repos\/o\/r\/collaborators\/([^/]+)\/permission$/.exec(path))) {
      if (world.permission === "error") throw new Error("HTTP 403");
      return { permission: world.permission ?? "admin" };
    }
    if ((match = /^repos\/o\/r\/pulls\/(\d+)$/.exec(path))) {
      const number = Number(match[1]);
      const author = Object.values(world.pulls ?? {}).flat().find((each) => each.number === number)?.user ?? LAGUS;
      return { user: author, head: { sha: headOf(number) }, changed_files: world.changedFiles?.[number] ?? (world.files?.[number] ?? [1]).length };
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
  it("passes a run whose commits all come from trusted App pull requests on safe paths (exit 0)", async () => {
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

  it("flags an author who is not on the trusted list (exit 1), also an owner or member of the organization", async () => {
    const result = await run({ pulls: { [sha(1)]: [pull(1, sha(1), { author_association: "MEMBER", user: OUTSIDER })] } });
    expect(result.code).toBe(1);
    expect(result.out).toContain("FLAG");
    expect(result.out).toContain("out");
  });

  it("accepts an outside author after a listed human approved (exit 0)", async () => {
    const world: World = {
      pulls: { [sha(1)]: [pull(1, sha(1), { user: OUTSIDER })] },
      reviews: { 1: [{ user: { login: "Boss" }, state: "APPROVED", commit_id: headOf(1) }] },
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

  it("keeps a sensitive path flagged after a listed human approved (exit 1)", async () => {
    const result = await run({ files: { 1: [{ filename: ".npmrc" }] }, reviews: { 1: [{ user: { login: "boss" }, state: "APPROVED", commit_id: headOf(1) }] } }, { reviewers: '["boss"]' });
    expect(result.code).toBe(1);
    expect(result.out).toContain("sensitive path");
  });

  it("keeps an incomplete file list flagged after a listed human approved (exit 1)", async () => {
    const result = await run({ changedFiles: { 1: 3001 }, reviews: { 1: [{ user: { login: "boss" }, state: "APPROVED", commit_id: headOf(1) }] } }, { reviewers: '["boss"]' });
    expect(result.code).toBe(1);
    expect(result.out).toContain("file list is incomplete");
  });

  it("does not take the shared account as a human approval, also when it is not in adminAuthors (exit 1)", async () => {
    const world = (trustedFile: object): World => ({
      pulls: { [sha(1)]: [pull(1, sha(1), { user: OUTSIDER })] },
      reviews: { 1: [{ user: { login: "RamaAditya49", id: 213913142, type: "User" }, state: "APPROVED", commit_id: headOf(1) }] },
      trustedFile,
    });
    expect((await run(world(TRUSTED), { reviewers: '["RamaAditya49"]' })).code).toBe(1);
    expect((await run(world({ ...TRUSTED, adminAuthors: [] }), { reviewers: '["RamaAditya49"]' })).code).toBe(1);
  });

  it("lets no human review clear anything when the trusted list is invalid (exit 1)", async () => {
    const world: World = {
      pulls: { [sha(1)]: [pull(1, sha(1), { user: OUTSIDER })] },
      reviews: { 1: [{ user: { login: "boss" }, state: "APPROVED", commit_id: headOf(1) }] },
    };
    expect((await run({ ...world, trustedFile: "badjson" }, { reviewers: '["boss"]' })).code).toBe(1);
    expect((await run({ ...world, trustedFile: { ...TRUSTED, version: 2 } }, { reviewers: '["boss"]' })).code).toBe(1);
    expect((await run({ ...world, trustedFile: "missing" }, { reviewers: '["boss"]' })).code).toBe(1);
    expect((await run({ ...world, trustedFile: TRUSTED }, { reviewers: '["boss"]' })).code).toBe(0);
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
      pulls: { [sha(1)]: [pull(1, sha(1), { user: OUTSIDER })] },
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
    expect(result.calls.some((call) => call.includes("/contents/package.json"))).toBe(false);
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
      pulls: { [sha(1)]: [pull(1, sha(1), { user: OUTSIDER })] },
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

describe("trusted authors", () => {
  const authored = (user: Account, extra: Partial<World> = {}): World => ({ pulls: { [sha(1)]: [pull(1, sha(1), { user })] }, ...extra });

  it("passes a listed App whose pull request has an approval of the reviewer App at the head commit (exit 0)", async () => {
    const result = await run(authored(LAGUS));
    expect(result.code).toBe(0);
    expect(result.calls).toContain(`repos/o/r/contents/${TRUSTED_AUTHORS_PATH}?ref=main`);
  });

  it("flags the same login with another ID, or another account type (exit 1)", async () => {
    for (const user of [{ ...LAGUS, id: 42 }, { ...LAGUS, type: "User" }, { ...LAGUS, login: "seira-evil[bot]" }]) {
      const result = await run(authored(user));
      expect(result.code, JSON.stringify(user)).toBe(1);
      expect(result.out).toContain("not a trusted author");
    }
  });

  it("flags an approval of an older commit, no approval, a later change request, and a reviewer with a wrong ID or type", async () => {
    for (const reviewerReview of ["old", "none", "changes", "wrongId", "wrongType"] as const) {
      const result = await run(authored(LAGUS, { reviewerReview }));
      expect(result.code, reviewerReview).toBe(1);
      expect(result.out, reviewerReview).toContain("no approval");
    }
  });

  it("flags a sensitive path whatever the author, and an approval of the reviewer App does not clear it", async () => {
    for (const user of [LAGUS, RAMA]) {
      const result = await run(authored(user, { files: { 1: [{ filename: ".github/release-trusted-authors.json" }] } }));
      expect(result.code).toBe(1);
      expect(result.out).toContain("sensitive path");
    }
    expect((await run(authored(LAGUS, { files: { 1: [{ filename: "scripts/release-gate.mjs" }] } }))).code).toBe(1);
  });

  it("passes the admin RamaAditya49 only when the API says admin and the reviewer App approved (exit 0)", async () => {
    expect((await run(authored(RAMA))).code).toBe(0);
    for (const permission of ["write", "maintain", "read"]) expect((await run(authored(RAMA, { permission }))).code, permission).toBe(1);
    const failed = await run(authored(RAMA, { permission: "error" }));
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("admin permission not confirmed");
    expect((await run(authored(RAMA, { reviewerReview: "none" }))).code).toBe(1);
  });

  it("never asks for admin permission of an account that is not listed", async () => {
    const result = await run(authored(OUTSIDER));
    expect(result.calls.some((call) => call.includes("/collaborators/"))).toBe(false);
  });

  it("fails closed: a missing or bad list flags every pull request, and an API error refuses the run", async () => {
    for (const trustedFile of ["missing", "badjson", { botAuthors: "x" }] as const) {
      const result = await run(authored(LAGUS, { trustedFile }));
      expect(result.code, JSON.stringify(trustedFile)).toBe(1);
    }
    expect((await run(authored(LAGUS, { trustedFile: "missing" }))).out).toContain("no author is trusted");
    await expect(run(authored(LAGUS, { trustedFile: "error" }))).rejects.toThrow("HTTP 502");
    const broken = async (path: string) => {
      if (/\/reviews\?/.test(path)) throw new Error("reviews down");
      return fake(authored(LAGUS)).api(path);
    };
    await expect(releaseGate({ api: broken, fetchJson: fake({}).fetchJson, repo: REPO, npmPackage: "@o/r", tag: "v1.1.0", log: () => {} })).rejects.toThrow("reviews down");
  });

  it("reads the list from main, never from a pull request", async () => {
    const result = await run(authored(LAGUS));
    expect(result.calls.filter((call) => call.includes("/contents/")).every((call) => call.endsWith("?ref=main"))).toBe(true);
  });

  it("keeps the committed list valid and under a sensitive path", () => {
    const text = readFileSync(new URL("../.github/release-trusted-authors.json", import.meta.url), "utf8");
    const parsed = parseTrustedAuthors(text);
    expect(parsed.valid).toBe(true);
    expect(parsed.reviewers.map((entry) => entry.login)).toEqual(["seira-roctis[bot]"]);
    expect(parsed.admins.map((entry) => entry.login)).toEqual(["RamaAditya49"]);
    expect(parsed.bots.every((entry) => entry.login.endsWith("[bot]"))).toBe(true);
    expect(isSensitivePath(TRUSTED_AUTHORS_PATH)).toBe(true);
  });

  it("rejects the whole list when one entry or the version is bad", () => {
    const good = { login: "a[bot]", id: 1 };
    const parse = (value: object) => parseTrustedAuthors(JSON.stringify(value));
    expect(parse(TRUSTED).valid).toBe(true);
    for (const bad of [{ login: "b[bot]" }, { login: "b[bot]", id: 0 }, { login: "b[bot]", id: 1.5 }, { login: 7, id: 2 }, { login: "b[bot]", id: 2, extra: true }, null, "x"]) {
      const result = parse({ ...TRUSTED, botAuthors: [good, bad] });
      expect(result.valid).toBe(false);
      expect(result.bots).toEqual([]);
      expect(result.admins).toEqual([]);
    }
    expect(parse({ ...TRUSTED, version: 2 }).valid).toBe(false);
    expect(parse({ ...TRUSTED, version: undefined }).valid).toBe(false);
    expect(parse({ ...TRUSTED, reviewerApps: {} }).valid).toBe(false);
    expect(parse({ version: 1, botAuthors: [], adminAuthors: [] }).valid).toBe(false);
  });

  it("rejects a duplicate ID or a duplicate login inside one list", () => {
    const parse = (list: object[]) => parseTrustedAuthors(JSON.stringify({ ...TRUSTED, botAuthors: list }));
    expect(parse([{ login: "a[bot]", id: 1 }, { login: "b[bot]", id: 1 }]).valid).toBe(false);
    expect(parse([{ login: "a[bot]", id: 1 }, { login: "A[BOT]", id: 2 }]).valid).toBe(false);
    expect(parse([{ login: "a[bot]", id: 1 }, { login: "b[bot]", id: 2 }]).valid).toBe(true);
  });

  it("matches an account by type, ID and login together", () => {
    const trusted = parseTrustedAuthors(JSON.stringify(TRUSTED));
    expect(authorKind(LAGUS, trusted)).toBe("bot");
    expect(authorKind(RAMA, trusted)).toBe("admin");
    expect(authorKind({ ...RAMA, type: "Bot" }, trusted)).toBeNull();
    expect(authorKind(undefined, trusted)).toBeNull();
    const review = (extra = {}) => ({ user: ROCTIS, state: "APPROVED", commit_id: "head", ...extra });
    expect(reviewerApproved([review()], trusted, "head")).toBe(true);
    expect(reviewerApproved([review({ commit_id: "old" })], trusted, "head")).toBe(false);
    expect(reviewerApproved([review({ user: { ...ROCTIS, id: 7 } })], trusted, "head")).toBe(false);
    expect(reviewerApproved([review()], trusted, undefined)).toBe(false);
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
