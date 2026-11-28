import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WATCHER_OPTIONS_CARD_BOT_ID } from "./options-card.ts";
import { availableTools } from "../server/drivers/agents-catalog.ts";
import { MEETING_TOOL_NAMES } from "../server/drivers/agents-meeting-tools.ts";
import { CORE_TOOLS } from "../server/drivers/agents-tool-groups.ts";
import { RELEASE_NOTES } from "../src/lib/release-notes.ts";
import { APP_FEATURE_DOES_MAX, APP_FEATURES, findAppFeatures, INTERNAL_AGENT_TOOLS } from "./app-features.ts";
import { GITHUB_APP_TOOL_NAMES } from "./github-app.ts";
import { AUTOMATION_VIEWS } from "./automation-views.ts";
import { BUILT_IN_SLASH_COMMANDS } from "./skill-command.ts";
import { MENTION_ROW_KINDS } from "../src/lib/mention-row-kinds.ts";

const FIX = "Add or update its entry in shared/app-features.ts, so a bot can tell the person where it is and what it does.";
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../server/drivers/agents-catalog-goldens/full.tools-list.json", import.meta.url)), "utf8")) as { tools: Array<{ name: string }> };
const everyProfileOn = { skillAuthoring: true, sharedComputers: true, voiceNotes: true, xResearch: true, research: true, cloudHome: false, memoryEnabled: true, chief: true, botId: WATCHER_OPTIONS_CARD_BOT_ID, team: true, seira: true, computerSelection: true, imageGeneration: true, meetings: true, appHosting: true };
const agentTools = new Set([...golden.tools.map((tool) => tool.name), ...availableTools(everyProfileOn).map((tool) => tool.name), ...CORE_TOOLS, ...MEETING_TOOL_NAMES, ...GITHUB_APP_TOOL_NAMES]);
const claimed = new Set(APP_FEATURES.flatMap((feature) => feature.tools ?? []));
const releaseNoteIds = RELEASE_NOTES.flatMap((note) => note.items.map((item) => item.id));

describe("app feature catalog", () => {
  it("gives every agent tool a feature or marks it internal", () => {
    const missing = [...agentTools].filter((name) => !claimed.has(name) && !INTERNAL_AGENT_TOOLS.has(name));
    expect(missing, `Agent tool without a feature: ${missing.join(", ")}. ${FIX}`).toEqual([]);
  });

  it("names only agent tools that exist", () => {
    const unknown = [...claimed].filter((name) => !agentTools.has(name));
    expect(unknown, `shared/app-features.ts names a tool the agents catalog does not have: ${unknown.join(", ")}. Remove it or fix its name.`).toEqual([]);
    const internalUnknown = [...INTERNAL_AGENT_TOOLS].filter((name) => !agentTools.has(name));
    expect(internalUnknown).toEqual([]);
  });

  it("gives every release note item, built-in slash command and Automations view a feature", () => {
    const notes = new Set(APP_FEATURES.flatMap((feature) => feature.releaseNotes ?? []));
    const missingNotes = releaseNoteIds.filter((id) => !notes.has(id));
    expect(missingNotes, `Release note item without a feature: ${missingNotes.join(", ")}. ${FIX}`).toEqual([]);
    const commands = new Set(APP_FEATURES.flatMap((feature) => feature.slashCommands ?? []));
    const missingCommands = BUILT_IN_SLASH_COMMANDS.filter((name) => !commands.has(name));
    expect(missingCommands, `Slash command without a feature: ${missingCommands.join(", ")}. ${FIX}`).toEqual([]);
    const views = new Set(APP_FEATURES.flatMap((feature) => feature.automationViews ?? []));
    const missingViews = AUTOMATION_VIEWS.filter((view) => !views.has(view));
    expect(missingViews, `Automations view without a feature: ${missingViews.join(", ")}. ${FIX}`).toEqual([]);
  });

  it("gives every @ list row kind a feature, and names only kinds that exist", () => {
    const rows = new Set(APP_FEATURES.flatMap((feature) => feature.mentionRows ?? []));
    const missing = MENTION_ROW_KINDS.filter((kind) => !rows.has(kind));
    expect(missing, `@ list row kind without a feature: ${missing.join(", ")}. ${FIX}`).toEqual([]);
    const unknown = [...rows].filter((kind) => !(MENTION_ROW_KINDS as readonly string[]).includes(kind));
    expect(unknown, `shared/app-features.ts names an @ list row kind that does not exist: ${unknown.join(", ")}. Remove it or fix its name.`).toEqual([]);
  });

  it("names only release notes, slash commands and views that exist", () => {
    const wrong = APP_FEATURES.flatMap((feature) => [
      ...(feature.releaseNotes ?? []).filter((id) => !releaseNoteIds.includes(id)).map((id) => `${feature.id}: release note ${id}`),
      ...(feature.slashCommands ?? []).filter((name) => !BUILT_IN_SLASH_COMMANDS.includes(name)).map((name) => `${feature.id}: command ${name}`),
      ...(feature.automationViews ?? []).filter((view) => !(AUTOMATION_VIEWS as readonly string[]).includes(view)).map((view) => `${feature.id}: view ${view}`),
    ]);
    expect(wrong).toEqual([]);
  });

  it("keeps ids unique, and a place and a short description on each feature", () => {
    const ids = APP_FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const feature of APP_FEATURES) {
      expect(feature.name.trim(), feature.id).not.toBe("");
      expect(feature.place.trim(), feature.id).not.toBe("");
      expect(feature.does.length, `${feature.id}: does is ${feature.does.length} characters`).toBeLessThanOrEqual(APP_FEATURE_DOES_MAX);
    }
  });

  it("tells a workflow from a routine", () => {
    const workflows = APP_FEATURES.find((feature) => feature.id === "workflows")!;
    expect(workflows.place).toBe("Automations → Workflows");
    expect(workflows.does).toMatch(/canvas/);
    expect(workflows.does).toMatch(/only when a routine uses it/);
    expect(workflows.does).toMatch(/Draw as workflow/);
    expect(APP_FEATURES.find((feature) => feature.id === "automations")!.tools).toEqual(["trigger_info", "trigger", "delete_trigger"]);
  });
});

describe("where people are invited", () => {
  const place = (id: string) => APP_FEATURES.find((feature) => feature.id === id)!.place;

  it("AC-01 names the places that invite and says the desktop app's own computer has none", () => {
    expect(place("people-access")).toMatch(/self-hosted server with email sign-in, in a browser or in the desktop app through Connect to a server/);
    expect(place("people-access")).toMatch(/Team Cloud/);
    expect(place("people-access")).toMatch(/desktop app's own computer has no invite/);
  });

  it("AC-02 says the Premium key is set on a self-hosted server", () => {
    expect(place("premium-key")).toBe("Settings → People, on a self-hosted server");
  });
});

describe("findAppFeatures", () => {
  it("finds a feature by the person's words, best match first", () => {
    expect(findAppFeatures("workflow")[0]!.id).toBe("workflows");
    expect(findAppFeatures("maksudku workflow seira")[0]!.id).toBe("workflows");
    expect(findAppFeatures("where are my routines")[0]!.id).toBe("automations");
    expect(findAppFeatures("trigger_info")[0]!.id).toBe("automations");
    expect(findAppFeatures("MCP server")[0]!.id).toBe("mcp-servers");
    expect(findAppFeatures("type /")[0]?.id).toBe("slash-menu");
  });

  it("returns at most `limit` features, and none for words that match nothing", () => {
    expect(findAppFeatures("bot", 2).length).toBeLessThanOrEqual(2);
    expect(findAppFeatures("zzzzqq")).toEqual([]);
  });

  it("returns every feature when the query has no usable words", () => {
    expect(findAppFeatures("")).toEqual([...APP_FEATURES]);
    expect(findAppFeatures("  the  ")).toEqual([...APP_FEATURES]);
  });

  it("AC-10: says that a bot sets the AI pool when asked and only the person adds a pay-per-use AI", () => {
    const feature = APP_FEATURES.find((one) => one.id === "ai-engines")!;
    expect(feature.does).toMatch(/AI pool/);
    expect(feature.does).toMatch(/bot sets it when you ask/i);
    expect(feature.does).toMatch(/only you add a pay-per-use AI/i);
  });
});
