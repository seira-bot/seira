import { describe, expect, it } from "vitest";

import { githubBotBranchPrefix, type GithubBotPolicy, type GithubRepoLevel } from "../../shared/github-app.ts";
import { decideGithubCall, githubGrantWidens, githubPolicyWidens, githubSwitchesAfter } from "./policy.ts";

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

describe("githubPolicyWidens", () => {
  const before = policy("pull_requests", { askBeforeBigChanges: true });
  const docs = { installationId: 1, repositoryId: 11, fullName: "shop/docs", level: "read" as const };

  it("is true for a first policy, a new repository, a higher level and a rule turned off", () => {
    expect(githubPolicyWidens(undefined, policy("read", { repos: [] }))).toBe(true);
    expect(githubPolicyWidens(before, { ...before, repos: [...before.repos, docs] })).toBe(true);
    expect(githubPolicyWidens(before, policy("write", { askBeforeBigChanges: true }))).toBe(true);
    expect(githubPolicyWidens(before, { ...before, askBeforeBigChanges: false })).toBe(true);
    expect(githubPolicyWidens(before, { ...before, ownBranchesOnly: false })).toBe(true);
  });

  it("is false for the same policy, a narrower one and a removal", () => {
    expect(githubPolicyWidens(before, before)).toBe(false);
    expect(githubPolicyWidens(before, policy("read", { askBeforeBigChanges: true }))).toBe(false);
    expect(githubPolicyWidens(before, { ...before, repos: [] })).toBe(false);
    expect(githubPolicyWidens({ ...before, askBeforeBigChanges: false, ownBranchesOnly: false }, before)).toBe(false);
    expect(githubPolicyWidens(before, null)).toBe(false);
    expect(githubPolicyWidens(undefined, null)).toBe(false);
  });
});

describe("githubGrantWidens", () => {
  const tools = (names: string[] | "*") => ({ connectorTools: { github_app: { tools: names } } });
  const level = (value: "read" | "write") => ({ connectorScopes: { apps: { github_app: value } } });

  it("is true for more tools or a higher level", () => {
    expect(githubGrantWidens(tools(["A"]), tools("*"))).toBe(true);
    expect(githubGrantWidens(tools(["A"]), tools(["A", "B"]))).toBe(true);
    expect(githubGrantWidens({ connectorTools: {} }, tools(["A"]))).toBe(true);
    expect(githubGrantWidens(tools(["A"]), {})).toBe(true);
    expect(githubGrantWidens(level("read"), level("write"))).toBe(true);
    expect(githubGrantWidens({ connectorScopes: { apps: {} } }, level("read"))).toBe(true);
    expect(githubGrantWidens(level("read"), {})).toBe(true);
  });

  it("is false for the same grant, fewer tools, a lower level, or another app", () => {
    expect(githubGrantWidens(tools("*"), tools("*"))).toBe(false);
    expect(githubGrantWidens(tools(["A", "B"]), tools(["B"]))).toBe(false);
    expect(githubGrantWidens(tools("*"), tools(["A"]))).toBe(false);
    expect(githubGrantWidens(tools(["A"]), { connectorTools: {} })).toBe(false);
    expect(githubGrantWidens(level("write"), level("read"))).toBe(false);
    expect(githubGrantWidens({}, level("read"))).toBe(false);
    expect(githubGrantWidens({ connectorScopes: { apps: { gmail: "read" } } }, { connectorScopes: { apps: { gmail: "write" } } })).toBe(false);
  });

  it("treats GitHub switched off as no access, so switching it on widens", () => {
    expect(githubGrantWidens({ ...tools("*"), composio: false }, tools("*"))).toBe(true);
    expect(githubGrantWidens({ ...level("read"), composio: false }, level("read"))).toBe(true);
    expect(githubGrantWidens({ ...tools("*"), composio: false }, { ...tools("*"), composio: false })).toBe(false);
    expect(githubGrantWidens(tools("*"), { ...tools("*"), composio: false })).toBe(false);
  });

  it("compares the account limit: more accounts or no limit widens, fewer does not", () => {
    const accounts = (ids: string[]) => ({ connectorScopes: { apps: { github_app: "write" as const }, accounts: { github_app: ids } } });
    const open = { connectorScopes: { apps: { github_app: "write" as const } } };
    expect(githubGrantWidens(accounts(["a"]), accounts(["a", "b"]))).toBe(true);
    expect(githubGrantWidens(accounts(["a"]), accounts(["b"]))).toBe(true);
    expect(githubGrantWidens(accounts(["a"]), open)).toBe(true);
    expect(githubGrantWidens(accounts(["a"]), {})).toBe(true);
    expect(githubGrantWidens(accounts(["a", "b"]), accounts(["b"]))).toBe(false);
    expect(githubGrantWidens(open, accounts(["a"]))).toBe(false);
  });

  it("sees the grant the store adds when a scope switches GitHub on", () => {
    const before = { connectorTools: { gmail: { tools: "*" as const } }, connectorScopes: { apps: { gmail: "read" as const } } };
    const patch = { connectorScopes: { apps: { gmail: "read" as const, github_app: "write" as const } } };
    // Raw merge: no github_app tool record, so GitHub looks switched off. The store grants it every tool.
    expect(githubSwitchesAfter(before, patch).connectorTools).toEqual({ gmail: { tools: "*" }, github_app: { tools: "*" } });
    expect(githubGrantWidens(before, githubSwitchesAfter(before, patch))).toBe(true);
    expect(githubGrantWidens(before, { ...before, ...patch }), "a raw merge misses it").toBe(false);
  });

  it("does not add a grant when the patch leaves scopes alone", () => {
    const before = { connectorTools: { gmail: { tools: "*" as const } }, connectorScopes: { apps: { gmail: "read" as const, github_app: "read" as const } } };
    expect(githubSwitchesAfter(before, { composio: true }).connectorTools).toEqual({ gmail: { tools: "*" } });
  });
});
