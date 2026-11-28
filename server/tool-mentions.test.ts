import { describe, expect, it } from "vitest";
import { taggedTools, taggedToolsFor, taggedToolsPrompt, toolMentionsAllowed, usableApps, type TurnTool } from "./tool-mentions.ts";

const tools: TurnTool[] = [
  { name: "Gmail", kind: "app", aliases: ["gmail"] },
  { name: "Google Sheets", kind: "app", aliases: ["googlesheets"] },
  { name: "Google", kind: "app", aliases: [] },
  { name: "notion", kind: "mcp", aliases: [] },
];

describe("taggedTools", () => {
  it("finds a tagged app and a tagged MCP server, once each, ignoring case", () => {
    expect(taggedTools("tolong pakai @gmail dan @NOTION, lalu @Gmail lagi", tools, [])).toEqual([
      { name: "Gmail", kind: "app" },
      { name: "notion", kind: "mcp" },
    ]);
  });

  it("matches an alias and reports the tool's own name", () => {
    expect(taggedTools("open @googlesheets now", tools, [])).toEqual([{ name: "Google Sheets", kind: "app" }]);
  });

  it("lets the longest name win", () => {
    expect(taggedTools("use @Google Sheets please", tools, [])).toEqual([{ name: "Google Sheets", kind: "app" }]);
  });

  it("ignores a name that continues into a longer word and a mid-word at-sign", () => {
    expect(taggedTools("@notionist and me@gmail.com", tools, [])).toEqual([]);
  });

  it("reads a tag that matches a bot as the bot (AC-08)", () => {
    expect(taggedTools("ask @Gmail", tools, ["Gmail"])).toEqual([]);
    expect(taggedTools("ask @Gmail", tools, ["Gm"])).toEqual([{ name: "Gmail", kind: "app" }]);
  });

  it("lets a longer tool name beat a shorter bot name", () => {
    expect(taggedTools("use @Google Sheets", tools, ["Google"])).toEqual([{ name: "Google Sheets", kind: "app" }]);
  });

  it("names nothing for a tool the turn does not have (AC-09)", () => {
    expect(taggedTools("use @Slack", tools, [])).toEqual([]);
    expect(taggedToolsPrompt([])).toBe("");
  });
});

describe("taggedToolsPrompt", () => {
  it("names each tool with its kind and tells the bot to use it", () => {
    expect(taggedToolsPrompt([{ name: "Gmail", kind: "app" }, { name: "notion", kind: "mcp" }])).toBe(
      "The person's message tags these tools: Gmail (a connected app), notion (an MCP server). They want them used for this request. If one fails, say so plainly.",
    );
  });
});

describe("usableApps", () => {
  const services = { gmail: { connected: true }, slack: { connected: true }, notion: { connected: false } };
  const cards = [{ slug: "gmail", label: "Gmail" }];

  it("keeps connected apps and labels them from the catalog, then from the slug", () => {
    expect(usableApps({}, services, cards)).toEqual([{ slug: "gmail", label: "Gmail" }, { slug: "slack", label: "Slack" }]);
  });

  it("leaves out an app the bot's scopes or tool grants do not name", () => {
    expect(usableApps({ connectorScopes: { apps: { gmail: "write" } } }, services, cards)).toEqual([{ slug: "gmail", label: "Gmail" }]);
    expect(usableApps({ connectorTools: { slack: { tools: "*" } } }, services, cards)).toEqual([{ slug: "slack", label: "Slack" }]);
  });
});

describe("taggedToolsFor", () => {
  const input = { text: "use @Gmail and @notion", botNames: [], mcpServers: ["notion"], apps: async () => [{ slug: "gmail", label: "Gmail" }] };

  it("names the tagged tools of a direct chat", async () => {
    expect(await taggedToolsFor({ ...input, direct: true })).toContain("Gmail (a connected app), notion (an MCP server)");
  });

  it("names nothing in a room, without an at-sign, or when the apps cannot load", async () => {
    expect(await taggedToolsFor({ ...input, direct: false })).toBe("");
    expect(await taggedToolsFor({ ...input, text: "use gmail", direct: true })).toBe("");
    expect(await taggedToolsFor({ ...input, direct: true, apps: async () => { throw new Error("down"); } })).toBe("The person's message tags these tools: notion (an MCP server). They want them used for this request. If one fails, say so plainly.");
  });

  it("names the native GitHub with its tools when it mounts, and prefers it to Composio GitHub (AC-06)", async () => {
    const both = { ...input, text: "use @GitHub", apps: async () => [{ slug: "github", label: "GitHub" }] };
    const text = await taggedToolsFor({ ...both, direct: true, github: true });
    expect(text).toContain("GitHub (the GitHub connection: use its GITHUB_APP_* tools, not Composio)");
    expect(await taggedToolsFor({ ...both, text: "use @github_app", direct: true, github: true, apps: null })).toContain("GITHUB_APP_*");
    expect(await taggedToolsFor({ ...both, direct: true })).toContain("GitHub (a connected app)");
    expect(await taggedToolsFor({ ...both, direct: true, github: true, apps: null, text: "use @Gmail" })).toBe("");
  });

  it("does not name an app the turn does not have", async () => {
    expect(await taggedToolsFor({ ...input, direct: true, apps: null })).not.toContain("Gmail");
  });
});

describe("toolMentionsAllowed", () => {
  const typed = { personLine: true, outside: false, guestConfined: false, fenced: false, botApi: false };

  it("allows a line the person typed in their own turn", () => {
    expect(toolMentionsAllowed(typed)).toBe(true);
  });

  it.each([
    ["a webhook, schedule or other automation line", { personLine: false }],
    ["a relayed line", { relayed: true }],
    ["an unattended run", { unattended: true }],
    ["an outside conversation", { outside: true }],
    ["a guest-confined thread", { guestConfined: true }],
    ["a fenced thread", { fenced: true }],
    ["a bot API thread", { botApi: true }],
  ])("refuses %s", (_name, change) => {
    expect(toolMentionsAllowed({ ...typed, ...change })).toBe(false);
  });
});
