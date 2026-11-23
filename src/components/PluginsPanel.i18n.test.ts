import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { locales } from "@/locales";
import { connectedInventoryCopy, connectorActionLabel } from "@/lib/connector-status";
import { disconnectAccountConfirmation } from "./PluginsPanel";
import { rowsBody, secretRow } from "./mcp-draft";
import { ConnectorCard } from "./ConnectorCard";
import { McpServersPanel } from "./McpServersPanel";

vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }),
}));

afterEach(() => {
  setLocale("en");
});

describe("plugins modal translation", () => {
  it("translates the account action label in every pack", () => {
    const state = {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: true,
      failed: false,
    };
    for (const [code, pack] of Object.entries(locales)) {
      setLocale(code);
      expect(connectorActionLabel("ready", state), code).toBe(pack["connectors.action.addAccount"]);
      expect(connectedInventoryCopy("error").title, code).toBe(pack["connectors.empty.errorTitle"]);
    }
  });

  it("keeps the account identity verbatim inside the translated confirmation", () => {
    setLocale("pt-br");
    const confirmation = disconnectAccountConfirmation("Gmail", { alias: "work" }, "work");
    expect(confirmation).toContain("“work”");
    expect(confirmation).toBe(
      t("connectors.disconnectConfirm", { identity: "“work”", service: "Gmail" }),
    );
    expect(confirmation).not.toContain("Disconnect");
  });

  it("translates an MCP environment parse error without touching the offending line", () => {
    setLocale("de");
    expect(rowsBody([secretRow({ name: "NOT A KEY", value: "value" })], "env")).toEqual({
      ok: false,
      error: { key: "mcp.env.invalidName", params: { key: "NOT A KEY" } },
    });
  });

  it("translates the Coret.id card's generic strings and leaves its untranslated copy in English", () => {
    setLocale("ja");
    const html = renderToStaticMarkup(createElement(() => McpServersPanel({ hostedCards: { shown: () => true, onConnections: () => {} } })));
    expect(html).toContain(`aria-label="${locales.ja!["hostedMcp.connect"]!.replace("{service}", "Coret.id")}"`);
    expect(html).toContain(locales.ja!["hostedMcp.access"]);
    expect(html).not.toContain("Connect Coret.id");
    expect(locales.ja).not.toHaveProperty("coret.description");
    expect(html).toContain("Create, edit and share mind maps, sketches and pads in Coret.id.");
  });

  it("translates the in-chat connector card", () => {
    setLocale("ja");
    const html = renderToStaticMarkup(createElement(ConnectorCard, {
      botId: "atlas",
      threadId: "thread",
      message: {
        id: "m1",
        role: "bot",
        kind: "connector",
        at: 1,
        connector: { slug: "gmail", label: "Gmail", description: "Read mail", status: "required", resumeKey: "resume1" },
      },
    }));
    expect(html).toContain(locales.ja!["connectors.card.connectSecurely"]);
    expect(html).toContain(locales.ja!["connectors.card.requested"]);
    expect(html).not.toContain("Connect securely");
  });
});
