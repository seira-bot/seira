import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { api, ApiError } from "@/state/api";
import { providerUsesText } from "./provider-uses";

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

afterEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
});

describe("what still uses a provider", () => {
  it("names each use, with the bot", () => {
    expect(providerUsesText({ usedBy: [
      { kind: "default" }, { kind: "model", bot: "Wax" }, { kind: "backup", bot: "Pen" },
      { kind: "thread", bot: "Ink", count: 2 }, { kind: "running", bot: "Ink" },
    ] })).toBe(t("provider.blocked.list", { list: [
      t("provider.blocked.default"), t("provider.blocked.model", { bot: "Wax" }), t("provider.blocked.backup", { bot: "Pen" }),
      t("provider.blocked.thread", { bot: "Ink", count: "2" }), t("provider.blocked.running", { bot: "Ink" }),
    ].join(", ") }));
  });

  it("shows the first few and counts the rest", () => {
    const usedBy = Array.from({ length: 8 }, (_, index) => ({ kind: "model", bot: `Bot ${index + 1}` }));
    const text = providerUsesText({ usedBy });
    const shown = Array.from({ length: 5 }, (_, index) => t("provider.blocked.model", { bot: `Bot ${index + 1}` })).join(", ");
    expect(text).toBe(t("provider.blocked.list", { list: t("provider.blocked.more", { list: shown, count: "3" }) }));
  });

  it("says nothing without a list, and skips entries it does not know", () => {
    expect(providerUsesText({ error: "x" })).toBe("");
    expect(providerUsesText({ usedBy: [] })).toBe("");
    expect(providerUsesText({ usedBy: [{ kind: "invented", bot: "Pen" }, { kind: "model" }, { kind: "thread", bot: "Ink", count: "2" }, null] })).toBe("");
  });

  it("reaches the message of a refused request, after the server's own line", async () => {
    vi.stubGlobal("fetch", respond(409, {
      error: "Choose another model for the bots and default model using this provider before hiding it.",
      usedBy: [{ kind: "thread", bot: "Ink", count: 1 }],
    }));
    const refused = await api("/api/instances/a", { method: "PATCH", body: "{}" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).message).toBe(`Choose another model for the bots and default model using this provider before hiding it. ${t("provider.blocked.list", { list: t("provider.blocked.thread", { bot: "Ink", count: "1" }) })}`);
  });
});
