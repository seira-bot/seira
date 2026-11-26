import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

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

  it("shows Undo once it is applied", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: applied, threadId: "thread-1" }));
    expect(html).toContain(">Undo<");
  });

  it("is not pending once it is applied", () => {
    expect(pendingApprovals([applied])).toEqual([]);
  });
});
