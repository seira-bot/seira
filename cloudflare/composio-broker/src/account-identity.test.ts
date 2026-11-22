import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  vi.resetModules();
  const { brokerHarness } = await import("./test-harness");
  const h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  const owner = await h.install();
  const named = (displayName?: string, created_at?: string) => ({
    ...(displayName ? { state: { val: { displayName } } } : {}),
    ...(created_at ? { created_at } : {}),
  });
  const deletes = () => h.composio.calls.filter((call) => call.method === "DELETE").map((call) => call.query.get("revoke_on_delete"));
  const remove = (slug: string, id: string) => h.call(owner, `/v1/connectors/${slug}/accounts/${id}`, { method: "DELETE" });
  return { h, owner, named, deletes, remove };
}

type Listed = { services: Record<string, { accounts: Array<Record<string, unknown>> }> };

describe("account identity", () => {
  it("reports displayName and marks only the newer active twin (AC-01, AC-04)", async () => {
    const { h, owner, named } = await setup();
    const old = h.account(owner, "github", "ACTIVE", named("OctoCat", "2026-01-01T00:00:00Z"));
    const twin = h.account(owner, "github", "ACTIVE", named("octocat", "2026-02-01T00:00:00Z"));
    const other = h.account(owner, "github", "ACTIVE", named("someone", "2026-03-01T00:00:00Z"));
    const response = await h.call(owner, "/v1/connectors?services=github");
    const { services } = await response.json() as Listed;
    const byId = Object.fromEntries(services.github!.accounts.map((account) => [account.id, account]));
    expect(byId[old]).toEqual({ id: old, status: "ACTIVE", displayName: "OctoCat" });
    expect(byId[twin]).toEqual({ id: twin, status: "ACTIVE", displayName: "octocat", duplicateOf: old });
    expect(byId[other]).toEqual({ id: other, status: "ACTIVE", displayName: "someone" });
  });

  it("sends neither field when Composio sends no name (AC-16)", async () => {
    const { h, owner } = await setup();
    h.account(owner, "github");
    h.account(owner, "github");
    const { services } = await (await h.call(owner, "/v1/connectors?services=github")).json() as Listed;
    for (const account of services.github!.accounts) {
      expect(account).not.toHaveProperty("displayName");
      expect(account).not.toHaveProperty("duplicateOf");
    }
  });

  it("drops an unprintable provider name", async () => {
    const { h, owner, named } = await setup();
    h.account(owner, "github", "ACTIVE", named("bad\nname"));
    const { services } = await (await h.call(owner, "/v1/connectors?services=github")).json() as Listed;
    expect(services.github!.accounts[0]).not.toHaveProperty("displayName");
  });

  it("deletes without revoke when a twin exists, and still answers { removed } (AC-07)", async () => {
    const { h, owner, named, deletes, remove } = await setup();
    h.account(owner, "gmail", "ACTIVE", named("me@example.com"));
    const twin = h.account(owner, "gmail", "ACTIVE", named("ME@example.com"));
    const response = await remove("gmail", twin);
    await expect(response.json()).resolves.toEqual({ removed: 1 });
    expect(deletes()).toEqual(["false"]);
  });

  it("deletes without revoke when another active account has no name (AC-07)", async () => {
    const { h, owner, named, deletes, remove } = await setup();
    h.account(owner, "gmail");
    await remove("gmail", h.account(owner, "gmail", "ACTIVE", named("me@example.com")));
    expect(deletes()).toEqual(["false"]);
  });

  it("revokes for the only account and for distinct names (AC-08)", async () => {
    const { h, owner, named, deletes, remove } = await setup();
    await remove("gmail", h.account(owner, "gmail", "ACTIVE", named("a@example.com")));
    const first = h.account(owner, "slack", "ACTIVE", named("a"));
    h.account(owner, "slack", "ACTIVE", named("b"));
    await remove("slack", first);
    expect(deletes()).toEqual(["true", "true"]);
  });

  it("keeps the grant on a toolkit-level disconnect while a twin exists", async () => {
    const { h, owner, named, deletes } = await setup();
    h.account(owner, "gmail", "ACTIVE", named("me@example.com"));
    h.account(owner, "gmail", "ACTIVE", named("me@example.com"));
    const response = await h.call(owner, "/v1/connectors/gmail", { method: "DELETE" });
    await expect(response.json()).resolves.toEqual({ removed: 1 });
    expect(deletes()).toEqual(["false"]);
  });
});
