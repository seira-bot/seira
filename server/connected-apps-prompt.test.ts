import { describe, expect, it } from "vitest";

import { connectedAppsPrompt } from "./connected-apps-prompt.ts";
import { composioSystemPrompt } from "./system-prompt.ts";

const READY = { engine: true, configured: true };

describe("connectedAppsPrompt", () => {
  it("tells a bot with apps off to turn them on and never to ask for credentials", () => {
    const text = connectedAppsPrompt({ composio: false, connectorTools: {} }, READY);
    expect(text).toContain("Connected apps are switched off for you");
    expect(text).toContain("turn on Connected apps in your settings under Access");
    expect(text).toMatch(/Never ask the user for an API key, token, password or sign-in/);
  });

  it("keeps the usual text for a bot with apps on", () => {
    const bot = { connectorTools: { gmail: { tools: "*" as const } } };
    expect(connectedAppsPrompt(bot, READY)).toBe(composioSystemPrompt(bot.connectorTools));
  });

  it("says nothing when the engine or the host cannot use apps", () => {
    expect(connectedAppsPrompt({ composio: false }, { engine: false, configured: true })).toBe("");
    expect(connectedAppsPrompt({ composio: false }, { engine: true, configured: false })).toBe("");
    expect(connectedAppsPrompt({}, { engine: true, configured: false })).toBe("");
  });

  it("says nothing for a bot with apps on when the turn mounts none", () => {
    expect(connectedAppsPrompt({}, { ...READY, mounted: false })).toBe("");
  });

  it("does not name GitHub as a Composio app when the bot has the native GitHub (AC-01)", () => {
    const text = connectedAppsPrompt({
      connectorTools: { gmail: { tools: "*" as const }, github_app: { tools: "*" as const } },
      connectorScopes: { apps: { gmail: "write", github_app: "write" } },
    }, READY);
    expect(text).toContain("Gmail");
    expect(text).not.toMatch(/github/i);
  });

  it("neither says there are no apps nor sends the bot to Composio for GitHub when GitHub is its only app (AC-02)", () => {
    const text = connectedAppsPrompt({
      connectorTools: { github_app: { tools: "*" as const } },
      connectorScopes: { apps: { github_app: "write" } },
    }, READY);
    expect(text).toBe(" This bot may use no other connected app.");
    expect(text).not.toContain("No connected apps");
    expect(text).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
  });
});
