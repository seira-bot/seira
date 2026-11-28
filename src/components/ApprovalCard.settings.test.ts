// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ admin: true as boolean | null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: vi.fn() }),
}));

const { titledCard, waitingSetting } = await import("./ApprovalCard");
const { ApprovalCard } = await import("./ApprovalCard");
const { pendingApprovals, PendingApprovalActions, PendingApprovalPanel } = await import("./PendingApproval");

const request = { settingId: "providers.xai.url", label: "xAI address", before: "", after: "https://example.test/v1", tier: "safe" as const };
const waiting: Message = {
  id: "waiting", role: "bot", kind: "options", at: 1,
  card: {
    title: "Change xAI address?", subtitle: "not set → https://example.test/v1\nYour saved key for xAI will be sent to example.test.",
    options: ["Apply", "Not now"], requestId: "request-1", tool: "app_settings", fixedOptions: true,
    appSettingRequest: { ...request, consequence: "Your saved key for xAI will be sent to example.test.", expiresAt: 2_000_000_000_000 },
  },
};
const applied: Message = {
  id: "applied", role: "bot", kind: "options", at: 2,
  card: {
    title: "Changed xAI address", subtitle: "not set → https://example.test/v1", options: [], requestId: "request-2", tool: "app_settings",
    fixedOptions: true, appSettingRequest: { ...request, result: "applied" }, answered: "allow", dismissed: true, autoApplied: true,
  },
};

beforeEach(() => { fixture.admin = true; });

describe("a bot's settings card that waits for a tap", () => {
  it("is a titled card, and an applied one is not a waiting setting", () => {
    expect(waitingSetting(waiting.card)).toBe(true);
    expect(titledCard(waiting.card)).toBe(true);
    expect(waitingSetting(applied.card)).toBe(false);
    expect(waitingSetting({ ...waiting.card!, appSettingRequest: undefined })).toBe(false);
  });

  it("is pending, and the panel leads with the card's own title and takes its deny label from the second option", () => {
    const [pending] = pendingApprovals([waiting]);
    expect(pending?.requestId).toBe("request-1");
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending!, count: 1, index: 0 }));
    expect(html).toContain("Change xAI address?");
    expect(html).toContain("Your saved key for xAI will be sent to example.test.");
  });

  it("labels its answers with the card's own options, not the generic Cancel", () => {
    const [pending] = pendingApprovals([waiting]);
    const html = renderToStaticMarkup(PendingApprovalActions({ pending: pending!, threadId: "thread-1", onCancelTurn: vi.fn() }));
    expect(html).toContain(">Not now<");
    expect(html).toContain(">Apply<");
    expect(html).not.toContain(">Cancel<");
  });

  it("shows a proposed text of 2,000 characters in full, and the text it replaces", () => {
    const proposed = `proposed ${"z".repeat(1991)}`;
    const earlier = `earlier ${"q".repeat(900)}`;
    const long: Message = {
      ...waiting, id: "long",
      card: { ...waiting.card!, title: "Change Rules for every bot?", subtitle: `${earlier}\n→\n${proposed}\nEvery bot will read this from now on.`,
        appSettingRequest: { ...request, settingId: "bots.everyBotRules", label: "Rules for every bot", before: earlier, after: proposed, consequence: "Every bot will read this from now on." } },
    };
    expect(proposed).toHaveLength(2000);
    const card = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: long, threadId: "thread-1" }));
    expect(card).toContain(proposed);
    expect(card).toContain(earlier);
    const [pending] = pendingApprovals([long]);
    expect(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending!, count: 1, index: 0 }))).toContain(proposed);
  });

  it("shows Undo once it is applied", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: applied, threadId: "thread-1" }));
    expect(html).toContain(">Undo<");
  });

  it("is not pending once it is applied", () => {
    expect(pendingApprovals([applied])).toEqual([]);
  });
});

describe("a waiting card in a conversation that others can read", () => {
  const shared: Message = {
    ...waiting, id: "shared",
    card: { ...waiting.card!, subtitle: "https://example.test/v1", appSettingRequest: { ...request, before: undefined, privateReview: true, expiresAt: 2_000_000_000_000 } },
  };

  it("offers the owner a button to read both values, and nothing on an own card", () => {
    const [pending] = pendingApprovals([shared]);
    const panel = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending!, count: 1, index: 0, threadId: "thread-1" }));
    expect(panel).toContain("Show what changes");
    const card = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: shared, threadId: "thread-1" }));
    expect(card).toContain("Show what changes");
    const own = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: waiting, threadId: "thread-1" }));
    expect(own).not.toContain("Show what changes");
  });

  it("shows the old and the new text after a click, and the server's words when the owner is refused", async () => {
    const answers: Array<{ status: number; body: unknown }> = [
      { status: 200, body: { before: "", after: "https://example.test/v1" } },
      { status: 403, body: { error: "Only the owner sees this." } },
    ];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const next = input.endsWith("/review") && init?.method === "POST" ? answers.shift()! : { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const click = async () => { await act(async () => { host.querySelector<HTMLButtonElement>("[data-setting-review] button")!.click(); }); await act(async () => {}); };
    await act(async () => { root.render(createElement(ApprovalCard, { bot: { name: "Luna" }, message: shared, threadId: "thread-1" })); });
    await click();
    expect(fetchMock.mock.calls.map(([input]) => input).filter((input) => input.endsWith("/review"))).toEqual(["/api/threads/thread-1/app-settings/request-1/review"]);
    expect(host.querySelector("[data-setting-review] pre")!.textContent).toBe("not set\n→\nhttps://example.test/v1");
    await act(async () => { root.unmount(); });
    const second = createRoot(host);
    await act(async () => { second.render(createElement(ApprovalCard, { bot: { name: "Luna" }, message: shared, threadId: "thread-1" })); });
    await click();
    expect(host.querySelector("[data-setting-review] [role=alert]")!.textContent).toBe("Only the owner sees this.");
    await act(async () => { second.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  });
});
