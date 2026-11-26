import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GithubAppStatus, GithubBotPolicy } from "../../shared/github-app";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(async () => true),
  cancel: vi.fn(),
}));

vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/lib/connector-oauth", () => ({ reserveConnectionPage: () => ({ open: fixture.open, cancel: fixture.cancel }) }));

import {
  clearGithubJustLinked, completeGithub, connectGithub, githubBotHint, githubBotsUsing, githubHighestLevel, githubTurnedOn, githubWithLevel,
  githubWithoutRepo, githubWithRepos, GithubCodeError, loadGithubApp, openGithubConnect, removeGithubAccount, resetGithubApp,
  refreshGithub, setGithubBotPolicy, useGithubApp,
} from "./github-app";

function snapshot() {
  let seen: ReturnType<typeof useGithubApp> | null = null;
  const Probe = () => { seen = useGithubApp({ load: false }); return null; };
  renderToString(createElement(Probe));
  return seen as unknown as ReturnType<typeof useGithubApp>;
}

const repo = { id: 7, name: "api", fullName: "acme/api", private: true, defaultBranch: "main" };
const status = (extra: Partial<GithubAppStatus> = {}): GithubAppStatus => ({
  enabled: true, connected: true, canEdit: true, ownedByYou: true, ownerLabel: "Rama",
  accounts: [{ installationId: 1, login: "acme", type: "Organization", repositorySelection: "selected", suspended: false, repositories: [repo] }],
  pending: [], bots: {}, ...extra,
});
const policy = (level: "read" | "pull_requests" | "write" = "read"): GithubBotPolicy => ({
  repos: [{ installationId: 1, repositoryId: 7, fullName: "acme/api", level }], askBeforeBigChanges: true, ownBranchesOnly: true,
});

beforeEach(() => {
  resetGithubApp();
  fixture.api.mockReset();
  fixture.open.mockClear();
  fixture.cancel.mockClear();
});

describe("GitHub connection calls", () => {
  it("reads the status once and keeps it", async () => {
    fixture.api.mockResolvedValue(status());
    await loadGithubApp();
    await loadGithubApp();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/github-app");
  });

  it("opens the page GitHub gives and cancels the reserved page afterwards", async () => {
    fixture.api.mockResolvedValue({ url: "https://github.com/apps/seira/installations/new", codeEntry: false });
    const start = await openGithubConnect();
    expect(start.opened).toBe(true);
    expect(fixture.open).toHaveBeenCalledWith("https://github.com/apps/seira/installations/new");
    expect(fixture.cancel).toHaveBeenCalled();
  });

  it("rejects an answer with no address", async () => {
    fixture.api.mockResolvedValue({});
    await expect(connectGithub()).rejects.toThrow();
  });

  it("sends the code in its clean form and refuses an empty one", async () => {
    fixture.api.mockResolvedValue(status());
    await completeGithub("  abcde-12345  ");
    const [path, init] = fixture.api.mock.calls[0]!;
    expect(path).toBe("/api/github-app/complete");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "ABCDE12345" });
    await expect(completeGithub("   ")).rejects.toBeInstanceOf(GithubCodeError);
  });

  it("marks a finished connect once, when the accounts or requests grew", async () => {
    fixture.api.mockResolvedValueOnce(status({ accounts: [], pending: [], connected: false }));
    await loadGithubApp();
    fixture.api.mockResolvedValueOnce({ url: "https://github.com/apps/seira/installations/new", codeEntry: false });
    await connectGithub();
    expect(snapshot().justLinked).toBe(false);
    fixture.api.mockResolvedValueOnce(status({ accounts: [], pending: [], connected: false }));
    await refreshGithub();
    expect(snapshot().justLinked).toBe(false);
    expect(snapshot().waiting).not.toBeNull();
    fixture.api.mockResolvedValueOnce(status());
    await refreshGithub();
    expect(snapshot().justLinked).toBe(true);
    expect(snapshot().waiting).toBeNull();
    clearGithubJustLinked();
    expect(snapshot().justLinked).toBe(false);
  });

  it("does not mark a refresh that no connect started", async () => {
    fixture.api.mockResolvedValue(status());
    await loadGithubApp();
    await refreshGithub();
    expect(snapshot().justLinked).toBe(false);
  });

  it("marks a finished code entry", async () => {
    fixture.api.mockResolvedValue(status());
    await completeGithub("abcde-12345");
    expect(snapshot().justLinked).toBe(true);
  });

  it("puts a bot's policy, and sends null to remove it", async () => {
    fixture.api.mockResolvedValue(status());
    await setGithubBotPolicy("scout", policy());
    await setGithubBotPolicy("scout", null);
    const [first, second] = fixture.api.mock.calls;
    expect(first![0]).toBe("/api/github-app/bots/scout");
    expect(first![1].method).toBe("PUT");
    expect(JSON.parse(first![1].body)).toEqual(policy());
    expect(second![1].body).toBe("null");
  });

  it("returns the address to remove Seira on GitHub after an account leaves", async () => {
    fixture.api.mockResolvedValue({ manageUrl: "https://github.com/settings/installations/1", status: status({ accounts: [], connected: false }) });
    expect(await removeGithubAccount(1)).toBe("https://github.com/settings/installations/1");
    expect(fixture.api.mock.calls[0]![0]).toBe("/api/github-app/accounts/1");
    expect(fixture.api.mock.calls[0]![1].method).toBe("DELETE");
  });
});

describe("GitHub policy helpers", () => {
  it("names the highest level and the bot's repositories", () => {
    expect(githubHighestLevel([])).toBeNull();
    expect(githubHighestLevel(policy("pull_requests").repos)).toBe("pull_requests");
    expect(githubBotHint(undefined)).toBe("No repositories yet");
    expect(githubBotHint(policy("write"))).toBe("Write in 1 repository");
    expect(githubBotHint({ ...policy(), repos: [...policy().repos, { installationId: 1, repositoryId: 8, fullName: "acme/web", level: "write" }] })).toBe("2 repositories · Write");
  });

  it("changes a level, removes a repository and adds new ones at Read", () => {
    const base = policy();
    expect(githubWithLevel(base, base.repos[0]!, "write").repos[0]!.level).toBe("write");
    expect(githubWithoutRepo(base, base.repos[0]!).repos).toEqual([]);
    const added = githubWithRepos(base, [{ installationId: 1, repo: repo }, { installationId: 1, repo: { ...repo, id: 8, name: "web", fullName: "acme/web" } }]);
    expect(added.repos.map((grant) => [grant.fullName, grant.level])).toEqual([["acme/api", "read"], ["acme/web", "read"]]);
  });

  it("turns a bot on with no repositories and the safe rules", () => {
    expect(githubTurnedOn()).toEqual({ repos: [], askBeforeBigChanges: true, ownBranchesOnly: true });
  });

  it("lists the bots that have a policy", () => {
    expect(githubBotsUsing(status({ bots: { a: policy() } }), [{ id: "a" }, { id: "b" }])).toEqual([{ id: "a" }]);
  });
});
