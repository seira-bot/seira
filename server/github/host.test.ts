import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GITHUB_APP_SLUG, GITHUB_APP_TOOL_NAMES, githubLevelPermissions, type GithubBotPolicy, type GithubRepoLevel } from "../../shared/github-app.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { fakeGithubRest } from "../testing/fake-github-rest.ts";
import { GITHUB_RECONNECT_MESSAGE, GITHUB_UNREACHABLE_MESSAGE, GithubBrokerError } from "./broker-client.ts";
import { createGithubHost, GITHUB_ACCESS_CHANGED_MESSAGE, GITHUB_INTERNAL_MCP_PATH, githubAccess, type GithubBot, type GithubHostDeps } from "./host.ts";
import { createGithubStore } from "./store.ts";
import type { GithubToolResult } from "./tools.ts";

const TOKEN = "ghs_fake_installation_token_2";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) { await flushDecisionLog(dir); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  vi.restoreAllMocks();
});

const policy = (level: GithubRepoLevel, over: Partial<GithubBotPolicy> = {}): GithubBotPolicy => ({
  repos: [{ installationId: 1, repositoryId: 10, fullName: "acme/web", level }], askBeforeBigChanges: false, ownBranchesOnly: true, ...over,
});

function fixture(options: { policy?: GithubBotPolicy | null; flag?: boolean; bot?: GithubBot | null; mint?: GithubHostDeps["broker"]["mintToken"]; ask?: GithubHostDeps["ask"] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "seira-github-host-")); dirs.push(dataDir);
  const store = createGithubStore(dataDir);
  store.write({
    version: 1, ownerLabel: "Rama",
    accounts: [{ installationId: 1, login: "acme", type: "Organization", repositorySelection: "all", suspended: false, repositories: [{ id: 10, name: "web", fullName: "acme/web", private: true, defaultBranch: "main" }] }],
    pending: [], bots: options.policy === null ? {} : { b1: options.policy ?? policy("write") },
  });
  const rest = fakeGithubRest("acme/web", { files: { "README.md": "hello" } });
  const mint = vi.fn(options.mint ?? (async () => ({ token: TOKEN, expiresAt: Date.now() + 3_600_000 })));
  const marked: string[] = [];
  const ask = vi.fn(options.ask ?? (async () => ({ ok: true as const, approved: true })));
  const bot: GithubBot | null = options.bot === undefined ? { id: "b1", name: "Ada" } : options.bot;
  const host = createGithubHost({ store, broker: { mintToken: mint }, dataDir, cfg: () => ({ features: {} }), bot: () => bot, ask, markOutside: (thread) => { marked.push(thread); }, env: { SEIRA_GITHUB_APP: options.flag === false ? "0" : "1" }, fetch: rest.fetch });
  const call = (name: string, args: Record<string, unknown> = {}) => host.handle({ method: "tools/call", params: { name, arguments: args } }, { botId: "b1", threadId: "t1" }, () => {}) as Promise<GithubToolResult>;
  return { host, call, mint, ask, rest, dataDir, marked, bot: bot ?? { id: "b1", name: "Ada" } };
}
const names = async (host: ReturnType<typeof fixture>["host"]) => ((await host.handle({ method: "tools/list" }, { botId: "b1", threadId: "t1" }, () => {})) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);

describe("the flag and the mount (AC-02)", () => {
  it("offers no server, no tools and no prompt while the flag is off", async () => {
    const off = fixture({ flag: false });
    expect(off.host.integration(off.bot, () => "cap", "http://127.0.0.1:1")).toBeNull();
    expect(off.host.prompt(off.bot)).toBe("");
    expect(off.host.toolListing()).toBeNull();
    expect(await names(off.host)).toEqual([]);
    expect((await off.call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" })).isError).toBe(true);
    expect(off.mint).not.toHaveBeenCalled();
    expect(off.rest.requests).toEqual([]);
  });

  it("offers nothing to a bot without a GitHub policy", async () => {
    const none = fixture({ policy: null });
    expect(none.host.integration(none.bot, () => "cap", "http://127.0.0.1:1")).toBeNull();
    expect(none.host.prompt(none.bot)).toBe("");
    expect(await names(none.host)).toEqual([]);
  });

  it("mounts the proxy with a turn capability and a short prompt, and keeps the secret out", () => {
    const on = fixture({ policy: policy("pull_requests") });
    const mount = on.host.integration(on.bot, () => "cap", "http://127.0.0.1:1")!;
    expect(mount.args.at(-1)).toBe("github");
    expect(mount.env.SEIRA_MCP_TOKEN_GITHUB).toBe("cap");
    expect(on.host.prompt(on.bot)).toContain("GITHUB_APP_");
    expect(on.host.prompt(on.bot)).toContain("seira/b1/");
    expect(fixture({ policy: policy("write", { ownBranchesOnly: false }) }).host.prompt({ id: "b1", name: "Ada" })).not.toContain("seira/b1/");
    expect(GITHUB_INTERNAL_MCP_PATH).toBe("/api/internal/github/mcp");
    expect(on.host.toolListing()).toHaveProperty(GITHUB_APP_SLUG);
  });

  it("lists only the tools the level reaches, and none a bot's grants leave out", async () => {
    expect(await names(fixture({ policy: policy("read") }).host)).toEqual(GITHUB_APP_TOOL_NAMES.filter((name) => /LIST|GET|SEARCH/u.test(name)));
    expect(await names(fixture({ policy: policy("pull_requests") }).host)).not.toContain("GITHUB_APP_MERGE_PULL");
    expect(await names(fixture({ policy: policy("write") }).host)).toEqual([...GITHUB_APP_TOOL_NAMES]);
    expect(githubAccess({ id: "b1", name: "Ada", connectorTools: { gmail: { tools: "*" } } }, "GITHUB_APP_GET_FILE").ok).toBe(false);
    expect(await names(fixture({ bot: { id: "b1", name: "Ada", composio: false } }).host)).toEqual([]);
  });
});

describe("what a call may do", () => {
  it("refuses a repository that is not granted, with no token and no GitHub request (AC-09)", async () => {
    const { call, mint, rest } = fixture();
    const answer = await call("GITHUB_APP_GET_FILE", { repo: "acme/secret", path: "README.md" });
    expect(answer).toEqual({ content: [{ type: "text", text: "Rama has not given this bot access to acme/secret." }], isError: true });
    expect(mint).not.toHaveBeenCalled();
    expect(rest.requests).toEqual([]);
  });

  it("refuses a bot that was removed, before anything runs", async () => {
    const { call, mint } = fixture({ bot: null });
    expect(await call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" })).toMatchObject({ isError: true });
    expect(mint).not.toHaveBeenCalled();
  });

  it("refuses every write tool at the read level (AC-10)", async () => {
    const { call, mint, rest } = fixture({ policy: policy("read") });
    const args: Record<string, Record<string, unknown>> = {
      GITHUB_APP_CREATE_COMMENT: { number: 1, body: "x" }, GITHUB_APP_CREATE_ISSUE: { title: "x" }, GITHUB_APP_CREATE_BRANCH: { branch: "seira/b1/x" },
      GITHUB_APP_COMMIT_FILES: { branch: "seira/b1/x", message: "m", files: [{ path: "a", content: "1" }] }, GITHUB_APP_CREATE_PULL: { title: "x", branch: "seira/b1/x" },
      GITHUB_APP_MERGE_PULL: { number: 1 }, GITHUB_APP_CLOSE_ISSUE_OR_PULL: { number: 1 }, GITHUB_APP_DELETE_BRANCH: { branch: "seira/b1/x" },
    };
    for (const [name, rest_] of Object.entries(args)) expect((await call(name, { repo: "acme/web", ...rest_ })).isError, name).toBe(true);
    expect(mint).not.toHaveBeenCalled();
    expect(rest.requests).toEqual([]);
  });

  it("lets pull requests commit to the bot's own branch and refuses main and a merge (AC-11)", async () => {
    const { call, rest } = fixture({ policy: policy("pull_requests") });
    const files = [{ path: "a.txt", content: "A" }];
    expect((await call("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/x", message: "m", files })).isError).toBeUndefined();
    expect(rest.branches.has("seira/b1/x")).toBe(true);
    const sent = rest.requests.length;
    expect((await call("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "main", message: "m", files })).isError).toBe(true);
    expect((await call("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/other/x", message: "m", files })).isError).toBe(true);
    expect((await call("GITHUB_APP_MERGE_PULL", { repo: "acme/web", number: 3 })).isError).toBe(true);
    expect(rest.requests).toHaveLength(sent);
  });

  it("never deletes the main branch, even where the policy would allow it", async () => {
    const { call, rest } = fixture({ policy: policy("write", { ownBranchesOnly: false }) });
    expect((await call("GITHUB_APP_DELETE_BRANCH", { repo: "acme/web", branch: "main" })).isError).toBe(true);
    expect(rest.requests).toEqual([]);
  });

  it("lists the granted repositories with their levels, without GitHub", async () => {
    const { call, rest, mint } = fixture({ policy: policy("pull_requests") });
    const answer = await call("GITHUB_APP_LIST_REPOS");
    expect(JSON.parse(answer.content[0]!.text)).toEqual({ repos: [{ repo: "acme/web", level: "pull_requests", defaultBranch: "main" }] });
    expect(rest.requests).toEqual([]);
    expect(mint).not.toHaveBeenCalled();
  });

  it("matches the repository without regard to case", async () => {
    const { call } = fixture();
    expect((await call("GITHUB_APP_GET_FILE", { repo: "ACME/Web", path: "README.md" })).isError).toBeUndefined();
  });
});

describe("a big change waits on the card (AC-12)", () => {
  it("opens the hold card for a merge and runs only after the owner allows", async () => {
    const { call, ask, rest } = fixture({ policy: policy("write", { askBeforeBigChanges: true }) });
    const answer = await call("GITHUB_APP_MERGE_PULL", { repo: "acme/web", number: 3 });
    expect(answer.isError).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatchObject({ botId: "b1", threadId: "t1", tool: "GITHUB_APP_MERGE_PULL", arguments: { repo: "acme/web", number: 3 } });
    expect(rest.requests.some((request) => request.method === "PUT")).toBe(true);
  });

  it("does nothing when the owner declines or nobody answers", async () => {
    const { call, rest, mint } = fixture({ policy: policy("write", { askBeforeBigChanges: true }), ask: async () => ({ ok: false, text: "Seira did not send this: the user declined." }) });
    expect(await call("GITHUB_APP_CLOSE_ISSUE_OR_PULL", { repo: "acme/web", number: 1 })).toMatchObject({ isError: true });
    expect(mint).not.toHaveBeenCalled();
    expect(rest.requests).toEqual([]);
  });

  it("asks for nothing when the owner turned the question off, and for no small change", async () => {
    const { call, ask } = fixture({ policy: policy("write", { askBeforeBigChanges: false }) });
    await call("GITHUB_APP_MERGE_PULL", { repo: "acme/web", number: 3 });
    expect(ask).not.toHaveBeenCalled();
    const small = fixture({ policy: policy("write", { askBeforeBigChanges: true }) });
    await small.call("GITHUB_APP_CREATE_COMMENT", { repo: "acme/web", number: 1, body: "x" });
    expect(small.ask).not.toHaveBeenCalled();
  });

  it("answers for a bot the owner narrowed while the card waited", async () => {
    let bot: GithubBot = { id: "b1", name: "Ada" };
    const base = fixture({ policy: policy("write", { askBeforeBigChanges: true }) });
    const host = createGithubHost({ store: createGithubStore(base.dataDir), broker: { mintToken: base.mint }, dataDir: base.dataDir, cfg: () => ({ features: {} }), bot: () => bot, env: { SEIRA_GITHUB_APP: "1" }, fetch: base.rest.fetch,
      markOutside: () => {}, ask: async () => { bot = { id: "b1", name: "Ada", composio: false }; return { ok: true, approved: true }; } });
    const answer = await host.handle({ method: "tools/call", params: { name: "GITHUB_APP_MERGE_PULL", arguments: { repo: "acme/web", number: 3 } } }, { botId: "b1", threadId: "t1" }, () => {}) as GithubToolResult;
    expect(answer.isError).toBe(true);
    expect(base.rest.requests).toEqual([]);
  });
});

describe("access that changes while a call waits", () => {
  const writes = (rest: ReturnType<typeof fixture>["rest"]) => rest.requests.filter((request) => request.method !== "GET");

  function changing(change: (store: ReturnType<typeof createGithubStore>) => void, options: Parameters<typeof fixture>[0] = {}) {
    const base = fixture(options);
    const store = createGithubStore(base.dataDir);
    const mint = vi.fn(async () => { change(store); return { token: TOKEN, expiresAt: Date.now() + 3_600_000 }; });
    const host = createGithubHost({ store, broker: { mintToken: mint }, dataDir: base.dataDir, cfg: () => ({ features: {} }), bot: () => base.bot, ask: base.ask, markOutside: () => {}, env: { SEIRA_GITHUB_APP: "1" }, fetch: base.rest.fetch });
    const call = (name: string, args: Record<string, unknown>) => host.handle({ method: "tools/call", params: { name, arguments: args } }, { botId: "b1", threadId: "t1" }, () => {}) as Promise<GithubToolResult>;
    return { ...base, store, mint, call };
  }

  it("sends nothing when the owner lowers the level while the token is made", async () => {
    const { call, rest, mint } = changing((store) => store.update((data) => { data.bots.b1 = policy("read"); }));
    const answer = await call("GITHUB_APP_CREATE_ISSUE", { repo: "acme/web", title: "T" });
    expect(answer).toMatchObject({ isError: true });
    expect(answer.content[0]!.text).toContain("has not allowed this bot");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(rest.requests).toEqual([]);
  });

  it("sends nothing when the owner raises the level while the token is made, because the token was made for the old one", async () => {
    const { call, rest } = changing((store) => store.update((data) => { data.bots.b1 = policy("write", { ownBranchesOnly: false }); }), { policy: policy("pull_requests") });
    expect(await call("GITHUB_APP_CREATE_ISSUE", { repo: "acme/web", title: "T" })).toEqual({ content: [{ type: "text", text: GITHUB_ACCESS_CHANGED_MESSAGE }], isError: true });
    expect(rest.requests).toEqual([]);
  });

  it("sends nothing when the account or the repository leaves while the token is made", async () => {
    for (const change of [
      (store: ReturnType<typeof createGithubStore>) => store.update((data) => { data.accounts = []; }),
      (store: ReturnType<typeof createGithubStore>) => store.update((data) => { data.accounts[0]!.repositories = []; }),
      (store: ReturnType<typeof createGithubStore>) => store.update((data) => { data.accounts[0]!.installationId = 2; data.bots.b1!.repos[0]!.installationId = 2; }),
    ]) {
      const { call, rest } = changing(change);
      expect((await call("GITHUB_APP_CREATE_COMMENT", { repo: "acme/web", number: 1, body: "hi" })).isError).toBe(true);
      expect(rest.requests).toEqual([]);
    }
  });

  it("does not merge without the card when the owner turns the question on while the token is made", async () => {
    const { call, rest, ask } = changing((store) => store.update((data) => { data.bots.b1!.askBeforeBigChanges = true; }));
    expect(await call("GITHUB_APP_MERGE_PULL", { repo: "acme/web", number: 3 })).toEqual({ content: [{ type: "text", text: GITHUB_ACCESS_CHANGED_MESSAGE }], isError: true });
    expect(ask).not.toHaveBeenCalled();
    expect(writes(rest)).toEqual([]);
  });

  it("does not merge after the card when the owner removed the repository while the card waited", async () => {
    let store: ReturnType<typeof createGithubStore> | undefined;
    const base = fixture({ policy: policy("write", { askBeforeBigChanges: true }), ask: async () => { store!.update((data) => { data.bots.b1!.repos = []; }); return { ok: true, approved: true }; } });
    store = createGithubStore(base.dataDir);
    expect((await base.call("GITHUB_APP_MERGE_PULL", { repo: "acme/web", number: 3 })).isError).toBe(true);
    expect(base.mint).not.toHaveBeenCalled();
    expect(base.rest.requests).toEqual([]);
  });

  it("stops a commit before its first change when access goes away after GitHub was read", async () => {
    const base = fixture({ policy: policy("write") });
    const store = createGithubStore(base.dataDir);
    const fetchThenRevoke = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await base.rest.fetch(input, init);
      store.update((data) => { delete data.bots.b1; });
      return response;
    }) as typeof fetch;
    const host = createGithubHost({ store, broker: { mintToken: base.mint }, dataDir: base.dataDir, cfg: () => ({ features: {} }), bot: () => base.bot, ask: base.ask, markOutside: () => {}, env: { SEIRA_GITHUB_APP: "1" }, fetch: fetchThenRevoke });
    const answer = await host.handle({ method: "tools/call", params: { name: "GITHUB_APP_COMMIT_FILES", arguments: { repo: "acme/web", branch: "seira/b1/x", message: "m", files: [{ path: "a.txt", content: "A" }] } } }, { botId: "b1", threadId: "t1" }, () => {}) as GithubToolResult;
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text).toContain("has not given this bot access");
    expect(base.rest.requests.length).toBeGreaterThan(0);
    expect(writes(base.rest)).toEqual([]);
  });

  it("sends nothing when the bot loses GitHub or the flag goes off while the token is made", async () => {
    let bot: GithubBot = { id: "b1", name: "Ada" };
    const env: NodeJS.ProcessEnv = { SEIRA_GITHUB_APP: "1" };
    for (const change of [() => { bot = { id: "b1", name: "Ada", composio: false }; }, () => { env.SEIRA_GITHUB_APP = "0"; }]) {
      bot = { id: "b1", name: "Ada" };
      env.SEIRA_GITHUB_APP = "1";
      const base = fixture();
      const host = createGithubHost({ store: createGithubStore(base.dataDir), broker: { mintToken: async () => { change(); return { token: TOKEN, expiresAt: Date.now() + 3_600_000 }; } }, dataDir: base.dataDir, cfg: () => ({ features: {} }), bot: () => bot, ask: base.ask, markOutside: () => {}, env, fetch: base.rest.fetch });
      expect((await host.handle({ method: "tools/call", params: { name: "GITHUB_APP_CREATE_ISSUE", arguments: { repo: "acme/web", title: "T" } } }, { botId: "b1", threadId: "t1" }, () => {}) as GithubToolResult).isError).toBe(true);
      expect(base.rest.requests).toEqual([]);
    }
  });

  it("sends nothing when the conversation stops while the token is made", async () => {
    let live = true;
    const base = fixture();
    const host = createGithubHost({ store: createGithubStore(base.dataDir), broker: { mintToken: async () => { live = false; return { token: TOKEN, expiresAt: Date.now() + 3_600_000 }; } }, dataDir: base.dataDir, cfg: () => ({ features: {} }), bot: () => base.bot, ask: base.ask, markOutside: () => {}, env: { SEIRA_GITHUB_APP: "1" }, fetch: base.rest.fetch });
    const stopped = new Error("stopped");
    await expect(host.handle({ method: "tools/call", params: { name: "GITHUB_APP_CREATE_ISSUE", arguments: { repo: "acme/web", title: "T" } } }, { botId: "b1", threadId: "t1" }, () => { if (!live) throw stopped; })).rejects.toBe(stopped);
    expect(base.rest.requests).toEqual([]);
  });

  it("runs when nothing changed", async () => {
    const { call, rest } = changing(() => {});
    expect((await call("GITHUB_APP_CREATE_ISSUE", { repo: "acme/web", title: "T" })).isError).toBeUndefined();
    expect(writes(rest)).toHaveLength(1);
  });
});

describe("the token", () => {
  it("is asked for one repository and the permissions of the bot's level (AC-13)", async () => {
    for (const level of ["read", "pull_requests", "write"] as const) {
      const { call, mint } = fixture({ policy: policy(level) });
      await call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" });
      expect(mint).toHaveBeenCalledWith(1, 10, level);
      expect(githubLevelPermissions(level)).toBeDefined();
    }
  });

  it("is sent to GitHub as a bearer and nowhere else, and never shows in a result, a log line or the decision log (AC-14)", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); });
    const { call, rest, dataDir } = fixture({ policy: policy("write") });
    const results: GithubToolResult[] = [];
    results.push(await call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" }));
    results.push(await call("GITHUB_APP_LIST_ISSUES", { repo: "acme/web" }));
    results.push(await call("GITHUB_APP_CREATE_COMMENT", { repo: "acme/web", number: 1, body: "hi" }));
    results.push(await call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "missing.txt" }));
    results.push(await call("GITHUB_APP_GET_FILE", { repo: "acme/other", path: "x" }));
    rest.failWith(403);
    results.push(await call("GITHUB_APP_GET_ISSUE", { repo: "acme/web", number: 1 }));
    expect(rest.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
    await flushDecisionLog(dataDir);
    const rows = readDecisions(dataDir, 100);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("is cut out of a result even when GitHub's own text carries it", async () => {
    const base = fixture();
    const leaky = fakeGithubRest("acme/web", { files: { "notes.txt": `copied ${TOKEN} here` } });
    const host = createGithubHost({ store: createGithubStore(base.dataDir), broker: { mintToken: base.mint }, dataDir: base.dataDir, cfg: () => ({ features: {} }), bot: () => base.bot, env: { SEIRA_GITHUB_APP: "1" }, fetch: leaky.fetch, ask: base.ask, markOutside: () => {} });
    const answer = await host.handle({ method: "tools/call", params: { name: "GITHUB_APP_GET_FILE", arguments: { repo: "acme/web", path: "notes.txt" } } }, { botId: "b1", threadId: "t1" }, () => {}) as GithubToolResult;
    expect(answer.content[0]!.text).not.toContain(TOKEN);
    expect(answer.content[0]!.text).toContain("[removed]");
  });
});

describe("a broker that refuses or cannot be reached (AC-15)", () => {
  it.each([
    ["reconnect", GITHUB_RECONNECT_MESSAGE],
    ["gone", GITHUB_RECONNECT_MESSAGE],
    ["unreachable", GITHUB_UNREACHABLE_MESSAGE],
  ] as const)("%s becomes a short message", async (kind, text) => {
    const { call, rest } = fixture({ mint: async () => { throw new GithubBrokerError(kind); } });
    expect(await call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" })).toEqual({ content: [{ type: "text", text }], isError: true });
    expect(rest.requests).toEqual([]);
  });

  it("hides an error it does not know behind the unreachable message", async () => {
    const { call } = fixture({ mint: async () => { throw new Error(`internal ${TOKEN} detail`); } });
    expect((await call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" })).content[0]!.text).toBe(GITHUB_UNREACHABLE_MESSAGE);
  });
});

describe("the decision log", () => {
  it("records an allowed call and a denied one without arguments", async () => {
    const { call, dataDir } = fixture({ policy: policy("read") });
    await call("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" });
    await call("GITHUB_APP_CREATE_ISSUE", { repo: "acme/web", title: "secret title" });
    await flushDecisionLog(dataDir);
    const rows = readDecisions(dataDir, 10);
    expect(rows.map((row) => `${row.tool}:${row.decision}`).sort()).toEqual(["GITHUB_APP_CREATE_ISSUE:auto-denied", "GITHUB_APP_GET_FILE:auto-approved"]);
    expect(JSON.stringify(rows)).not.toContain("secret title");
  });
});

describe("text from GitHub is outside work", () => {
  it("marks the conversation for every read of GitHub text, even when the read fails", async () => {
    const reads: Array<[string, Record<string, unknown>]> = [
      ["GITHUB_APP_GET_FILE", { path: "README.md" }], ["GITHUB_APP_SEARCH_CODE", { query: "x" }], ["GITHUB_APP_LIST_ISSUES", {}],
      ["GITHUB_APP_GET_ISSUE", { number: 1 }], ["GITHUB_APP_LIST_PULLS", {}], ["GITHUB_APP_GET_PULL", { number: 3 }],
    ];
    for (const [name, rest_] of reads) {
      const { call, marked, rest } = fixture({ policy: policy("read") });
      await call(name, { repo: "acme/web", ...rest_ });
      expect(marked, name).toEqual(["t1"]);
      const failing = fixture({ policy: policy("read") });
      failing.rest.failWith(502);
      expect((await failing.call(name, { repo: "acme/web", ...rest_ })).isError, name).toBe(true);
      expect(failing.marked, name).toEqual(["t1"]);
      expect(rest.requests.length).toBeGreaterThan(0);
    }
  });

  it("marks nothing for the list of granted repositories or a refused call", async () => {
    const { call, marked } = fixture();
    await call("GITHUB_APP_LIST_REPOS");
    await call("GITHUB_APP_GET_FILE", { repo: "acme/secret", path: "README.md" });
    expect(marked).toEqual([]);
  });
});
