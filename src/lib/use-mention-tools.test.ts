// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotApp } from "@/components/bot-settings/useBotApps";
import type { MentionChoice } from "@/components/MentionMenu";

const fixture = vi.hoisted(() => ({ api: vi.fn(), apps: vi.fn(), cards: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), api: fixture.api }));
vi.mock("./connected-apps", () => ({ preloadConnectedApps: fixture.apps }));
vi.mock("@/components/bot-settings/useBotApps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/bot-settings/useBotApps")>()),
  loadAppCards: fixture.cards,
}));

import { resetGithubApp } from "./github-app";
import { mentionToolChoices, useMentionTools } from "./use-mention-tools";

const app = (slug: string, label: string, scope: BotApp["scope"] = "write"): BotApp => ({ slug, label, blurb: "", card: { logo: null, domain: null, label }, scope });

describe("mentionToolChoices", () => {
  it("lists usable apps, then MCP servers that are on, each sorted", () => {
    const rows = mentionToolChoices([app("notion", "Notion"), app("gmail", "Gmail"), app("slack", "Slack", null)], [
      { name: "zeta", on: true }, { name: "alpha", on: true }, { name: "off", on: false },
    ]);
    expect(rows.map((row) => [row.name, row.tool?.kind])).toEqual([["Gmail", "app"], ["Notion", "app"], ["alpha", "mcp"], ["zeta", "mcp"]]);
  });

  it("shows an app and an MCP server of one name as one row, the app's", () => {
    const rows = mentionToolChoices([app("googlesheets", "Google Sheets")], [{ name: "google-sheets", on: true }, { name: "google_sheets", on: true }, { name: "other", on: true }]);
    expect(rows.map((row) => [row.name, row.tool?.kind])).toEqual([["Google Sheets", "app"], ["other", "mcp"]]);
  });
});

describe("mentionToolChoices and GitHub", () => {
  it("keeps only the native GitHub row when Composio GitHub is usable too (AC-05)", () => {
    const rows = mentionToolChoices([app("github", "Github"), app("github_app", "GitHub")], []);
    expect(rows.map((row) => row.tool?.slug)).toEqual(["github_app"]);
    expect(mentionToolChoices([app("github", "Github")], []).map((row) => row.tool?.slug)).toEqual(["github"]);
  });
});

describe("useMentionTools", () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: MentionChoice[] = [];
  const bot = { id: "scout", composio: undefined, connectorScopes: undefined, connectorTools: undefined };
  const Probe = ({ active }: { active: boolean }) => { latest = useMentionTools(bot, active); return null; };
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };

  beforeEach(() => {
    latest = [];
    resetGithubApp();
    container = document.createElement("div");
    root = createRoot(container);
    fixture.cards.mockResolvedValue(new Map());
  });
  afterEach(() => { flushSync(() => root.unmount()); vi.clearAllMocks(); });

  it("loads only while the list is open and keeps the answer after it closes", async () => {
    fixture.apps.mockResolvedValue({ services: { gmail: { connected: true } }, authoritative: true });
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/email") return { state: "off" };
      return { servers: [{ name: "notion", enabled: true, on: true }, { name: "idle", enabled: true, on: false }] };
    });
    flushSync(() => root.render(createElement(Probe, { active: false })));
    await settle();
    expect(fixture.api).not.toHaveBeenCalled();
    flushSync(() => root.render(createElement(Probe, { active: true })));
    await settle();
    expect(latest.map((row) => row.name)).toEqual(["Gmail", "notion"]);
    flushSync(() => root.render(createElement(Probe, { active: false })));
    expect(latest.map((row) => row.name)).toEqual(["Gmail", "notion"]);
  });

  it("returns no tool and does not throw when every request fails", async () => {
    fixture.apps.mockRejectedValue(new Error("down"));
    fixture.cards.mockRejectedValue(new Error("down"));
    fixture.api.mockRejectedValue(new Error("down"));
    flushSync(() => root.render(createElement(Probe, { active: true })));
    await settle();
    expect(latest).toEqual([]);
  });

  it("lists one GitHub row for a bot that may use the connected GitHub (AC-05)", async () => {
    fixture.apps.mockResolvedValue({ services: {}, authoritative: true });
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/email") return { state: "off" };
      if (path === "/api/github-app") return { enabled: true, connected: true, accounts: [], pending: [], bots: { scout: { repos: [], askBeforeBigChanges: true, ownBranchesOnly: true } } };
      return { servers: [] };
    });
    const github = { id: "scout", composio: undefined, connectorScopes: { apps: { github_app: "write" as const } }, connectorTools: undefined };
    const Github = () => { latest = useMentionTools(github, true); return null; };
    flushSync(() => root.render(createElement(Github)));
    await settle();
    expect(latest.map((row) => row.name)).toEqual(["GitHub"]);
  });

  it("keeps the GitHub row when the Composio app list cannot be read (AC-05)", async () => {
    fixture.apps.mockResolvedValue({ services: { gmail: { connected: true } }, authoritative: false });
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/email") return { state: "off" };
      if (path === "/api/github-app") return { enabled: true, connected: true, accounts: [], pending: [], bots: { scout: { repos: [], askBeforeBigChanges: true, ownBranchesOnly: true } } };
      return { servers: [] };
    });
    const github = { id: "scout", composio: undefined, connectorScopes: undefined, connectorTools: undefined };
    const Github = () => { latest = useMentionTools(github, true); return null; };
    flushSync(() => root.render(createElement(Github)));
    await settle();
    expect(latest.map((row) => row.name)).toEqual(["GitHub"]);
  });
});
