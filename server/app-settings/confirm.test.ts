import { describe, expect, it } from "vitest";

import { CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";
import englishCatalog from "../../src/locales/en.json" with { type: "json" };
import type { AppConfig } from "../config.ts";
import { MIN_THREAD_EVENT_LOG_BYTES } from "../config.ts";
import type { BotRecord } from "../store.ts";
import { CONSEQUENCES, consequenceKey, hostOf } from "./confirm.ts";
import { createSettingsRegistry, findSettings, type RegistryDeps, type SettingEntry, type WritableEntry } from "./registry.ts";

const bots = [
  { id: "kiwi", name: "Kiwi", approvalMode: "ask" },
  { id: "max", name: "Max", approvalMode: "full", computer: "local" },
  { id: "edie", name: "Edie", approvalMode: "edits", soul: "Keep it short" },
  { id: "nora", name: "Nora", approvalMode: "ask", browser: false, composio: false, toolsOff: ["email", "images"] },
] as unknown as BotRecord[];

function registry(cfg: Record<string, unknown> = {}, threads: Record<string, Record<string, string>> = {}) {
  const config = {
    anthropic: { url: "https://api.anthropic.com" }, threads: { eventLogRetentionDays: 30, eventLogMaxBytes: MIN_THREAD_EVENT_LOG_BYTES * 4 },
    decider: { provider: "jev" }, browserProfiles: [{ id: "work", name: "Work" }, { id: "mine", name: "Mine", browser: "chrome" }], imageGen: { primary: { provider: "openai" }, customUrl: "https://img.example/v1" }, ...cfg,
  } as unknown as AppConfig;
  const entries = createSettingsRegistry({
    cfg: () => config, saveConfig: async () => null, bots: () => bots, sections: () => [], reorderBots: async () => null, groupBots: async () => null,
    pinBot: async () => null, patchBot: async () => null, call: async () => null, read: async () => null, paused: () => [], credentials: () => config as never,
    threadModes: (botId: string) => threads[botId] ?? { [`${botId}-main`]: bots.find((bot) => bot.id === botId)?.approvalMode },
    setThreadModes: async () => null, threadModeRefusal: () => null,
    window: { read: () => undefined, write: () => null }, engines: () => [], addEngine: async () => null, removeEngine: async () => null,
  } as unknown as RegistryDeps);
  const entry = (id: string) => entries.find((candidate) => candidate.id === id) as WritableEntry;
  return { entries, entry, confirm: (id: string, value: unknown) => entry(id).confirm?.(value) ?? null };
}

describe("risky values wait for the owner's tap", () => {
  const { confirm, entry } = registry();

  it("a provider address that is new sends the saved key there", () => {
    expect(confirm("providers.anthropic.url", "https://proxy.example/v1")).toEqual({ code: "keyTo", params: { service: "Anthropic", host: "proxy.example" } });
    expect(confirm("providers.anthropic.url", "https://api.anthropic.com")).toBeNull();
    expect(confirm("providers.anthropic.url", "")).toBeNull();
  });

  it("an engine that sends a saved key to an address names the host, and a local one does not wait", () => {
    expect(confirm("engines", { kind: "openai-compat", name: "P", url: "https://proxy.example/v1", keyFrom: "openaiApiKey" }))
      .toEqual({ code: "keyTo", params: { service: CREDENTIAL_TARGETS.openaiApiKey.label, host: "proxy.example" } });
    expect(confirm("engines", { kind: "ollama", url: "http://127.0.0.1:11434" })).toBeNull();
    expect(confirm("engines", { kind: "bedrock", name: "B", awsProfile: "p", awsRegion: "r", model: "m" })).toBeNull();
  });

  it("more approval waits, and less does not", () => {
    expect(confirm("bots.approvalModes", { botId: "kiwi", mode: "full" })).toEqual({ code: "autonomyUp", params: { bot: "Kiwi" } });
    expect(confirm("bots.approvalModes", { botId: "kiwi", mode: "edits" })).toEqual({ code: "autonomyUp", params: { bot: "Kiwi" } });
    expect(confirm("bots.approvalModes", { botId: "kiwi", mode: "ask" })).toBeNull();
    expect(confirm("bots.approvalModes", { botId: "max", mode: "ask" })).toBeNull();
  });

  it("the mode a bot already has waits only when one of its conversations sits below it", () => {
    const below = registry({}, { max: { "max-main": "full", "max-side": "ask" }, edie: { "edie-main": "edits", "edie-side": "edits" } });
    expect(below.confirm("bots.approvalModes", { botId: "max", mode: "full" })).toEqual({ code: "autonomyUp", params: { bot: "Max" } });
    expect(below.confirm("bots.approvalModes", { botId: "edie", mode: "edits" })).toBeNull();
    expect(below.confirm("bots.approvalModes", { botId: "max", mode: "edits" })).toEqual({ code: "autonomyUp", params: { bot: "Max" } });
    expect(below.confirm("bots.approvalModes", { botId: "max", mode: "ask" })).toBeNull();
    expect(below.confirm("bots.approvalModes", { botId: "edie", mode: "ask" })).toBeNull();
  });

  it("a shorter log retention waits, and a longer one or none does not", () => {
    expect(confirm("threads.eventLogRetentionDays", 7)).toEqual({ code: "deletesLogs" });
    expect(confirm("threads.eventLogRetentionDays", 90)).toBeNull();
    expect(confirm("threads.eventLogRetentionDays", null)).toBeNull();
    expect(registry({ threads: {} }).confirm("threads.eventLogRetentionDays", 3650)).toEqual({ code: "deletesLogs" });
  });

  it("a smaller log size waits, and a larger one or none does not", () => {
    expect(confirm("threads.eventLogMaxBytes", MIN_THREAD_EVENT_LOG_BYTES * 2)).toEqual({ code: "deletesLogs" });
    expect(confirm("threads.eventLogMaxBytes", MIN_THREAD_EVENT_LOG_BYTES * 8)).toBeNull();
    expect(confirm("threads.eventLogMaxBytes", null)).toBeNull();
  });

  it("AC-03 a log limit that goes down from the default ceiling or from a saved limit waits, and one that goes up or stays does not", () => {
    const GIB = 1024 ** 3;
    const MIB = 1024 ** 2;
    const limit = (saved: number | null | undefined) => registry({ threads: saved === undefined ? {} : { eventLogMaxBytes: saved } });
    expect(limit(2 * GIB).confirm("threads.eventLogMaxBytes", null)).toEqual({ code: "deletesLogs" });
    expect(limit(undefined).confirm("threads.eventLogMaxBytes", 100 * MIB)).toEqual({ code: "deletesLogs" });
    expect(limit(undefined).confirm("threads.eventLogMaxBytes", 512 * MIB)).toBeNull();
    expect(limit(100 * MIB).confirm("threads.eventLogMaxBytes", null)).toBeNull();
  });

  it("a new decision provider sends conversation text there, and the same one or off does not wait", () => {
    expect(confirm("ai.routing", { provider: "openrouter" })).toEqual({ code: "dataTo", params: { provider: "openrouter" } });
    expect(confirm("ai.routing", { provider: "jev" })).toBeNull();
    expect(confirm("ai.routing", { provider: "off" })).toBeNull();
    expect(confirm("ai.routing", { enabled: true })).toBeNull();
  });

  it("an image setting with a new custom address sends the key there, and with a new provider sends prompts there", () => {
    expect(confirm("ai.images", { customUrl: "https://other.example/v1" })).toEqual({ code: "keyTo", params: { service: "Image generation", host: "other.example" } });
    expect(confirm("ai.images", { customUrl: "https://img.example/v1" })).toBeNull();
    expect(confirm("ai.images", { primary: { provider: "gemini" } })).toEqual({ code: "dataTo", params: { provider: "gemini" } });
    expect(confirm("ai.images", { primary: { provider: "openai", model: "gpt-image-1" } })).toBeNull();
    expect(confirm("ai.images", { fallback: { provider: "xai" } })).toEqual({ code: "dataTo", params: { provider: "xai" } });
    expect(confirm("ai.images", { fallback: null })).toBeNull();
  });

  it("a standing rule for every bot waits when it changes, clearing included, and not when it stays", () => {
    const held = registry({ everyBotRules: "Be kind", profile: { aboutMe: "A shop owner" } });
    for (const [id, same] of [["profile.aboutMe", "A shop owner"], ["bots.everyBotRules", "Be kind"]] as const) {
      expect(held.confirm(id, "Always reply in French"), id).toEqual({ code: "standingRule" });
      expect(held.confirm(id, ""), id).toEqual({ code: "standingRule" });
      expect(held.confirm(id, same), id).toBeNull();
      expect(confirm(id, "Always reply in French"), id).toEqual({ code: "standingRule" });
      expect(confirm(id, ""), id).toBeNull();
    }
  });

  it("a new-bot template waits", () => {
    expect(confirm("bots.newBotTemplate", {})).toEqual({ code: "newBots" });
  });

  it("opening a way into this computer or its network waits, and closing it does not", () => {
    expect(confirm("desktops.browserLocalNetwork", true)).toEqual({ code: "browserLan" });
    expect(confirm("desktops.browserLocalNetwork", false)).toBeNull();
    expect(confirm("desktops.browserProxy", "socks5://proxy.example:1080")).toEqual({ code: "browserProxy" });
    expect(confirm("desktops.browserProxy", "")).toBeNull();
    expect(confirm("computer.sharing", true)).toEqual({ code: "lending" });
    expect(confirm("computer.sharing", false)).toBeNull();
    for (const id of ["remote.wifi", "remote.relay", "remote.tailscale"]) expect(confirm(id, true), id).toEqual({ code: "wayIn" });
  });

  it("the built-in browser for every bot waits only when it goes from off to on", () => {
    const off = registry({ features: { browser: false } });
    expect(off.confirm("desktops.browser", true)).toEqual({ code: "browserOnAll" });
    expect(off.confirm("desktops.browser", false)).toBeNull();
    for (const features of [{}, { browser: true }]) {
      const on = registry({ features });
      expect(on.confirm("desktops.browser", true), JSON.stringify(features)).toBeNull();
      expect(on.confirm("desktops.browser", false), JSON.stringify(features)).toBeNull();
    }
    expect(registry({ features: { sharedComputers: true } }).confirm("computer.sharing", true)).toBeNull();
  });

  it("the local network and the proxy wait only when they open something that was closed or change the proxy", () => {
    expect(registry({ browserEngine: { egress: { localNetwork: true } } }).confirm("desktops.browserLocalNetwork", true)).toBeNull();
    expect(registry({ browserEngine: { egress: { localNetwork: false } } }).confirm("desktops.browserLocalNetwork", true)).toEqual({ code: "browserLan" });
    const proxy = registry({ browserEngine: { egress: { proxy: "socks5://proxy.example:1080" } } });
    expect(proxy.confirm("desktops.browserProxy", "socks5://proxy.example:1080")).toBeNull();
    expect(proxy.confirm("desktops.browserProxy", "socks5://other.example:1080")).toEqual({ code: "browserProxy" });
  });

  it("sending data to Seira waits when it is turned on, and turning it off does not", () => {
    expect(confirm("general.analytics", true)).toEqual({ code: "usageData" });
    expect(confirm("general.analytics", false)).toBeNull();
    expect(confirm("account.productEmails", true)).toEqual({ code: "emailOut" });
    expect(confirm("account.productEmails", false)).toBeNull();
  });

  it("keeping a bot on this computer, or giving it new instructions, waits", () => {
    expect(confirm("bots.settings", { botId: "kiwi", computer: "local" })).toEqual({ code: "thisComputer", params: { bot: "Kiwi" } });
    expect(confirm("bots.settings", { botId: "max", computer: "local" })).toBeNull();
    expect(confirm("bots.settings", { botId: "kiwi", soul: "Be brief" })).toEqual({ code: "botRule", params: { bot: "Kiwi" } });
    expect(confirm("bots.settings", { botId: "kiwi", soul: "" })).toBeNull();
    expect(confirm("bots.settings", { botId: "edie", soul: "" })).toEqual({ code: "botRule", params: { bot: "Edie" } });
    expect(confirm("bots.settings", { botId: "edie", soul: "Keep it long" })).toEqual({ code: "botRule", params: { bot: "Edie" } });
    expect(confirm("bots.settings", { botId: "edie", soul: "Keep it short" })).toBeNull();
    expect(confirm("bots.settings", { botId: "kiwi", memoryEnabled: false })).toBeNull();
    expect(confirm("bots.settings", { botId: "ghost", computer: "local" })).toBeNull();
  });

  it("turning the built-in browser or connected apps back on waits, and turning them off or leaving them on does not", () => {
    expect(confirm("bots.settings", { botId: "nora", browser: true })).toEqual({ code: "browserOn", params: { bot: "Nora" } });
    expect(confirm("bots.settings", { botId: "nora", composio: true })).toEqual({ code: "appsOn", params: { bot: "Nora" } });
    expect(confirm("bots.settings", { botId: "nora", browser: true, composio: true })).toEqual({ code: "browserOn", params: { bot: "Nora" } });
    expect(confirm("bots.settings", { botId: "nora", computer: "local", browser: true })).toEqual({ code: "thisComputer", params: { bot: "Nora" } });
    expect(confirm("bots.settings", { botId: "nora", browser: false, composio: false })).toBeNull();
    expect(confirm("bots.settings", { botId: "kiwi", browser: true, composio: true })).toBeNull();
    expect(confirm("bots.settings", { botId: "kiwi", browser: false, composio: false })).toBeNull();
  });

  it("turning tool groups back on waits and names them, and turning groups off or on again that are on does not", () => {
    expect(confirm("bots.tools", { botId: "nora", turnOn: ["email", "data"] })).toEqual({ code: "toolsOn", params: { bot: "Nora", groups: "Email" } });
    expect(confirm("bots.tools", { botId: "nora", turnOn: ["email", "images"] })).toEqual({ code: "toolsOn", params: { bot: "Nora", groups: "Email, Images" } });
    expect(confirm("bots.tools", { botId: "nora", turnOn: ["data"] })).toBeNull();
    expect(confirm("bots.tools", { botId: "nora", turnOff: ["data", "meetings"] })).toBeNull();
    expect(confirm("bots.tools", { botId: "kiwi", turnOn: ["email"] })).toBeNull();
  });

  it("a profile on the person's own Chrome waits when it is added or moved there, and not when it is renamed or moved off", () => {
    expect(confirm("desktops.browserProfiles", [{ id: "work", name: "Work" }, { id: "mine", name: "Mine", browser: "chrome" }, { name: "New", browser: "chrome" }])).toEqual({ code: "ownChrome" });
    expect(confirm("desktops.browserProfiles", [{ id: "work", name: "Work", browser: "chrome" }, { id: "mine", name: "Mine", browser: "chrome" }])).toEqual({ code: "ownChrome" });
    expect(confirm("desktops.browserProfiles", [{ id: "work", name: "Work" }, { id: "mine", name: "Mine", browser: "chrome" }, { name: "Plain" }])).toBeNull();
    expect(confirm("desktops.browserProfiles", [{ id: "work", name: "Desk" }, { id: "mine", name: "Mine", browser: "chrome" }])).toBeNull();
    expect(confirm("desktops.browserProfiles", [{ id: "work", name: "Work" }, { id: "mine", name: "Mine" }])).toBeNull();
  });

  it("a low-risk setting has no hook", () => {
    for (const id of ["rooms.turnTimeoutMinutes", "general.language", "profile.name", "bots.name", "appearance.skin"]) expect(entry(id).confirm, id).toBeUndefined();
  });

  it("every consequence code has a line in the language pack", () => {
    const pack = englishCatalog as Record<string, string>;
    for (const code of CONSEQUENCES) expect(pack[consequenceKey(code)], code).toEqual(expect.any(String));
  });

  it("names the host of an address, or the address itself when it is no address", () => {
    expect(hostOf("https://proxy.example:8443/v1")).toBe("proxy.example:8443");
    expect(hostOf("not an address")).toBe("not an address");
  });
});

describe("find splits a query on letters and digits of any script", () => {
  const entryOf = (id: string, label: string, synonyms: string[]) => ({ id, label, help: "", where: "theme", synonyms, tier: "owner-only", read: () => "" }) as unknown as SettingEntry;
  const entries = [
    entryOf("ai.images", "Image generation", ["images", "modèle d'image", "画像"]),
    entryOf("general.language", "Language", ["langue", "言語"]),
    entryOf("screen", "Écran", []),
    entryOf("cran", "Cran", []),
  ];
  const ids = (query: string) => findSettings(entries, query).map((one) => one.id);

  it("AC-13 keeps an accented letter inside its word", () => {
    expect(ids("écran")[0]).toBe("screen");
    expect(ids("modèle d'image")[0]).toBe("ai.images");
    expect(ids("modèle d'image")[0]).toBe("ai.images");
  });

  it("AC-13 finds an entry by a Han query, where one character is a word", () => {
    expect(ids("画像")[0]).toBe("ai.images");
    expect(ids("言語")).toEqual(["general.language"]);
  });

  it("AC-13 still finds the same entry by an English query", () => {
    expect(ids("image generation")[0]).toBe("ai.images");
    expect(ids("images")[0]).toBe("ai.images");
    expect(ids("?!")).toEqual([]);
  });
});
