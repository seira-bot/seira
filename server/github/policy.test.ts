import { describe, expect, it } from "vitest";

import { githubBotBranchPrefix, type GithubBotPolicy, type GithubRepoLevel } from "../../shared/github-app.ts";
import { decideGithubCall } from "./policy.ts";

const prefix = githubBotBranchPrefix("ada");
const policy = (level: GithubRepoLevel, over: Partial<GithubBotPolicy> = {}): GithubBotPolicy => ({
  repos: [{ installationId: 1, repositoryId: 10, fullName: "shop/site", level }],
  askBeforeBigChanges: false,
  ownBranchesOnly: true,
  ...over,
});
const repo = { installationId: 1, repositoryId: 10 };
const call = (tool: string, p: GithubBotPolicy | undefined, extra: { branch?: string; defaultBranch?: string; repo?: Parameters<typeof decideGithubCall>[0]["repo"] } = {}) =>
  decideGithubCall({ policy: p, botId: "ada", tool, repo: extra.repo ?? repo, branch: extra.branch, defaultBranch: extra.defaultBranch ?? "main", ownerLabel: "Rama" });

describe("github policy", () => {
  it("denies a bot with no policy and names the owner", () => {
    expect(call("GITHUB_APP_GET_FILE", undefined, { repo: { fullName: "shop/site" } })).toEqual({ verdict: "deny", message: "Rama has not given this bot access to shop/site." });
  });

  it("denies a repository that is not in the list", () => {
    const out = call("GITHUB_APP_GET_FILE", policy("write"), { repo: { installationId: 1, repositoryId: 99 } });
    expect(out).toMatchObject({ verdict: "deny" });
    expect((out as { message: string }).message).toContain("Rama has not given this bot access");
  });

  it("matches by full name without case", () => {
    expect(call("GITHUB_APP_GET_FILE", policy("read"), { repo: { fullName: "Shop/Site" } }).verdict).toBe("allow");
  });

  it("lets read tools through at the read level", () => {
    expect(call("GITHUB_APP_GET_FILE", policy("read")).verdict).toBe("allow");
  });

  it("refuses every write tool at the read level (AC-10)", () => {
    for (const tool of ["GITHUB_APP_CREATE_COMMENT", "GITHUB_APP_CREATE_ISSUE", "GITHUB_APP_CREATE_BRANCH", "GITHUB_APP_COMMIT_FILES", "GITHUB_APP_CREATE_PULL", "GITHUB_APP_MERGE_PULL", "GITHUB_APP_CLOSE_ISSUE_OR_PULL", "GITHUB_APP_DELETE_BRANCH"]) {
      expect(call(tool, policy("read"), { branch: `${prefix}x` }).verdict).toBe("deny");
    }
  });

  it("denies an unknown tool", () => {
    expect(call("GITHUB_APP_NOPE", policy("write")).verdict).toBe("deny");
  });

  it("allows pushes only to the bot's own branches at the pull requests level and refuses merge (AC-11)", () => {
    const p = policy("pull_requests");
    expect(call("GITHUB_APP_COMMIT_FILES", p, { branch: `${prefix}fix` }).verdict).toBe("allow");
    expect(call("GITHUB_APP_COMMIT_FILES", p, { branch: "main" }).verdict).toBe("deny");
    expect(call("GITHUB_APP_CREATE_BRANCH", p, { branch: "feature/x" }).verdict).toBe("deny");
    expect(call("GITHUB_APP_MERGE_PULL", p).verdict).toBe("deny");
  });

  it("keeps the branch prefix at the write level while the switch is on", () => {
    const p = policy("write");
    expect(call("GITHUB_APP_COMMIT_FILES", p, { branch: "main" }).verdict).toBe("deny");
    expect(call("GITHUB_APP_COMMIT_FILES", p, { branch: `${prefix}x` }).verdict).toBe("allow");
  });

  it("with the switch off, keeps the default branch closed at pull requests and opens every branch at write", () => {
    expect(call("GITHUB_APP_COMMIT_FILES", policy("pull_requests", { ownBranchesOnly: false }), { branch: "feature/x" }).verdict).toBe("allow");
    expect(call("GITHUB_APP_COMMIT_FILES", policy("pull_requests", { ownBranchesOnly: false }), { branch: "main" }).verdict).toBe("deny");
    expect(call("GITHUB_APP_COMMIT_FILES", policy("write", { ownBranchesOnly: false }), { branch: "main" }).verdict).toBe("allow");
  });

  it("denies a branch tool without a branch", () => {
    expect(call("GITHUB_APP_COMMIT_FILES", policy("write")).verdict).toBe("deny");
  });

  it("asks for merge, close and branch delete while big changes need an answer (AC-12)", () => {
    const p = policy("write", { askBeforeBigChanges: true });
    expect(call("GITHUB_APP_MERGE_PULL", p)).toMatchObject({ verdict: "ask" });
    expect(call("GITHUB_APP_CLOSE_ISSUE_OR_PULL", p)).toMatchObject({ verdict: "ask" });
    expect(call("GITHUB_APP_DELETE_BRANCH", p, { branch: `${prefix}x` })).toMatchObject({ verdict: "ask" });
    expect(call("GITHUB_APP_MERGE_PULL", policy("write")).verdict).toBe("allow");
  });

  it("gives the matched grant on allow", () => {
    expect(call("GITHUB_APP_GET_FILE", policy("read"))).toMatchObject({ verdict: "allow", grant: { repositoryId: 10, level: "read" } });
  });
});
