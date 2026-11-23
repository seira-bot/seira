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
});
