import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

async function twoInstallations() {
  vi.resetModules();
  const { brokerHarness } = await import("./test-harness");
  const h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  const mine = await h.install(), theirs = await h.install();
  return { h, mine, theirs };
}

describe("Composio users per installation", () => {
  it("names each new installation's Composio user seira_ and the installation id", async () => {
    const { h, mine, theirs } = await twoInstallations();
    for (const installation of [mine, theirs]) {
      const [row] = h.d1.rows<{ composio_user_id: string }>("SELECT composio_user_id FROM installations WHERE id = ?", installation.id);
      expect(row?.composio_user_id).toBe(`seira_${installation.id.replaceAll("-", "")}`);
      expect(row?.composio_user_id).toMatch(/^seira_[0-9a-f]{32}$/);
    }
  });

  it("never treats another user's account as this installation's, even when Composio lists it", async () => {
    const { h, mine, theirs } = await twoInstallations();
    const gmail = h.account(theirs);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/connected_accounts")) {
        return Response.json({ items: h.composio.accounts, next_cursor: null });
      }
      return h.composio.fetchImpl(input, init);
    });

    const status = await h.call(mine, "/v1/connectors?services=gmail");
    expect(status.status).toBe(200);
    const listed = await status.json() as { services: { gmail: { accounts: Array<{ id: string }> } } };
    expect(listed.services.gmail.accounts.map((account) => account.id)).not.toContain(gmail);

    const trigger = await h.call(mine, "/v1/triggers", {
      method: "POST",
      body: JSON.stringify({ slug: "GMAIL_NEW_GMAIL_MESSAGE", connectedAccountId: gmail, config: {} }),
    });
    expect(trigger.status).toBe(403);

    const removed = await h.call(mine, `/v1/connectors/gmail/accounts/${gmail}`, { method: "DELETE" });
    await expect(removed.json()).resolves.toEqual({ removed: 0 });
    expect(h.composio.accounts.map((account) => account.id)).toContain(gmail);
    expect(h.composio.callsTo("/trigger_instances")).toHaveLength(0);
  });
});
