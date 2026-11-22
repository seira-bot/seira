import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { authorizeService, connectionStatus, removeAccount, removeService, setManagedBrokerAccess } from "./composio.ts";
import { startFakeComposioProject, type FakeComposioProject } from "./testing/fake-composio-project.ts";

const KEY = "ak_identity_test";
const USER = "seira_identity";
const cfg: AppConfig = { composio: { apiKey: KEY, userId: USER } };
let project: FakeComposioProject;

beforeAll(async () => {
  project = await startFakeComposioProject(KEY);
  vi.stubEnv("SEIRA_COMPOSIO_API", project.api);
});
afterEach(() => {
  project.accounts.length = 0;
  project.requests.length = 0;
  setManagedBrokerAccess(null);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await project.close();
});

const deletes = () => project.requests.filter((request) => request.method === "DELETE");

describe("own-key account identity", () => {
  it("reports displayName and marks only the newer active twin (AC-01, AC-04)", async () => {
    const old = project.connect(USER, "github", { displayName: "OctoCat", createdAt: "2026-01-01T00:00:00Z" });
    const twin = project.connect(USER, "github", { displayName: "octocat", createdAt: "2026-02-01T00:00:00Z" });
    const other = project.connect(USER, "github", { displayName: "someone", createdAt: "2026-03-01T00:00:00Z" });
    const { github } = await connectionStatus(cfg, ["github"]);
    const byId = Object.fromEntries((github?.accounts ?? []).map((account) => [account.id, account] as const));
    expect(byId[old]).toEqual({ id: old, status: "ACTIVE", displayName: "OctoCat" });
    expect(byId[twin]).toEqual({ id: twin, status: "ACTIVE", displayName: "octocat", duplicateOf: old });
    expect(byId[other]).toEqual({ id: other, status: "ACTIVE", displayName: "someone" });
  });

  it("marks no duplicate when Composio sends no name (AC-16 shape)", async () => {
    project.connect(USER, "github");
    project.connect(USER, "github");
    const { github } = await connectionStatus(cfg, ["github"]);
    expect((github?.accounts ?? []).every((account) => account.displayName === undefined && account.duplicateOf === undefined)).toBe(true);
  });

  it("deletes without revoke when a twin exists (AC-07)", async () => {
    project.connect(USER, "gmail", { displayName: "me@example.com" });
    const twin = project.connect(USER, "gmail", { displayName: "ME@example.com" });
    await expect(removeAccount(cfg, "gmail", twin)).resolves.toEqual({ removed: 1 });
    expect(deletes().map((request) => request.revoke)).toEqual([false]);
  });

  it("deletes without revoke when another account has no name (AC-07)", async () => {
    project.connect(USER, "gmail");
    const named = project.connect(USER, "gmail", { displayName: "me@example.com" });
    await removeAccount(cfg, "gmail", named);
    expect(deletes().map((request) => request.revoke)).toEqual([false]);
  });

  it("revokes for the only account and for distinct names (AC-08)", async () => {
    const only = project.connect(USER, "gmail", { displayName: "a@example.com" });
    await removeAccount(cfg, "gmail", only);
    const first = project.connect(USER, "slack", { displayName: "a" });
    project.connect(USER, "slack", { displayName: "b" });
    await removeAccount(cfg, "slack", first);
    expect(deletes().map((request) => request.revoke)).toEqual([true, true]);
  });

  it("keeps the grant on a toolkit-level disconnect while a twin exists", async () => {
    project.connect(USER, "gmail", { displayName: "me@example.com" });
    project.connect(USER, "gmail", { displayName: "me@example.com" });
    await removeService(cfg, "gmail");
    expect(deletes().map((request) => request.revoke)).toEqual([false]);
  });

  it("decides revoke by the same rule when it replaces an expired account with the same label", async () => {
    const expire = (id: string) => Object.assign(project.accounts.find((account) => account.id === id)!, { status: "EXPIRED", alias: "work" });
    project.connect(USER, "github", { displayName: "x" });
    expire(project.connect(USER, "github"));
    await authorizeService(cfg, "github", "work");
    expect(deletes().map((request) => request.revoke)).toEqual([false]);

    project.accounts.length = 0;
    project.requests.length = 0;
    expire(project.connect(USER, "github"));
    await authorizeService(cfg, "github", "work");
    expect(deletes().map((request) => request.revoke)).toEqual([true]);
  });
});

describe("broker account identity (AC-01, AC-16)", () => {
  const brokerCfg: AppConfig = {};
  const respond = (accounts: unknown[]) => vi.stubGlobal("fetch", async () =>
    Response.json({ services: { github: { connected: true, status: "ACTIVE", accounts } } }));

  it("passes sanitized displayName and duplicateOf through", async () => {
    setManagedBrokerAccess({ url: "https://broker.test/identity", token: "a".repeat(64) });
    respond([
      { id: "ca_old", status: "ACTIVE", displayName: " octocat " },
      { id: "ca_new", status: "ACTIVE", displayName: "octocat", duplicateOf: "ca_old" },
      { id: "ca_bad", status: "ACTIVE", displayName: "x\ny", duplicateOf: "ca_missing" },
    ]);
    const { github } = await connectionStatus(brokerCfg, ["github"]);
    expect(github!.accounts).toEqual([
      { id: "ca_old", status: "ACTIVE", displayName: "octocat" },
      { id: "ca_new", status: "ACTIVE", displayName: "octocat", duplicateOf: "ca_old" },
      { id: "ca_bad", status: "ACTIVE" },
    ]);
  });

  it("accepts an older broker that sends neither field", async () => {
    setManagedBrokerAccess({ url: "https://broker.test/identity-old", token: "a".repeat(64) });
    respond([{ id: "ca_one", status: "ACTIVE", alias: "work" }]);
    const { github } = await connectionStatus(brokerCfg, ["github"]);
    expect(github!.accounts).toEqual([{ id: "ca_one", status: "ACTIVE", alias: "work" }]);
  });
});
