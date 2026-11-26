import { afterEach, describe, expect, it } from "vitest";

import { credentialConfigPatch, credentialIsConfigured } from "../../shared/credential-request.ts";
import type { AppConfig } from "../config.ts";
import { consequenceKey } from "./confirm.ts";
import { createSettingsRegistry, type RegistryDeps, type SettingEntry, type WritableEntry } from "./registry.ts";

const PIN = "SEIRA_DECISION_RETENTION_DAYS";
const pinBefore = process.env[PIN];
afterEach(() => {
  if (pinBefore === undefined) delete process.env[PIN]; else process.env[PIN] = pinBefore;
});

const none = async () => null;
function registry(cfg: Record<string, unknown>) {
  const saved: Array<Record<string, unknown>> = [];
  const deps: RegistryDeps = {
    cfg: () => cfg as unknown as AppConfig, saveConfig: async (patch) => { saved.push(patch); return null; }, bots: () => [], sections: () => [], reorderBots: none, groupBots: none, pinBot: none, patchBot: none,
    call: none, read: async () => null, paused: () => [], credentials: () => (cfg as RegistryDeps["credentials"] extends () => infer C ? C : never), window: { read: () => undefined, write: () => null },
    engines: () => [], addEngine: none, removeEngine: none, threadModes: () => ({}), setThreadModes: none, threadModeRefusal: () => null,
  };
  const entries = createSettingsRegistry(deps);
  const entry = (id: string): WritableEntry => {
    const found = entries.find((one: SettingEntry) => one.id === id);
    if (!found || found.tier !== "safe") throw new Error(`no writable entry ${id}`);
    return found;
  };
  return { entries, entry, saved };
}

describe("a provider address change (AC-09)", () => {
  const withKeys = {
    anthropic: { key: "env-anthropic", url: "https://old.example" }, xai: { key: "env-xai" }, groq: { key: "env-groq" }, meta: { key: "env-meta" },
    openaiCompat: { key: "env-compat", url: "https://old.example", model: "old" }, tts: { key: "env-tts", fishKey: "env-fish", voice: "v1", baseUrl: "http://old.example" },
  };
  const cases: Array<[string, unknown, Record<string, unknown>]> = [
    ["providers.anthropic.url", "https://a.example", { anthropic: { url: "https://a.example" } }],
    ["providers.xai.url", "https://x.example", { xai: { url: "https://x.example" } }],
    ["providers.groq.url", "https://g.example", { groq: { url: "https://g.example" } }],
    ["providers.meta.url", "https://m.example", { meta: { url: "https://m.example" } }],
    ["providers.openaiCompat.url", "https://o.example", { openaiCompat: { url: "https://o.example" } }],
    ["providers.openaiCompat.model", "new-model", { openaiCompat: { model: "new-model" } }],
    ["voice.baseUrl", "http://v.example", { tts: { baseUrl: "http://v.example" } }],
  ];
  it.each(cases)("saves only the changed field for %s, so no key reaches the file", async (id, value, patch) => {
    const fx = registry(withKeys);
    expect(await fx.entry(id).write(value)).toBeNull();
    expect(fx.saved).toEqual([patch]);
    expect(JSON.stringify(fx.saved)).not.toMatch(/env-/);
  });
});

describe("the voice provider setting (AC-01 to AC-03)", () => {
  const entry = (cfg: Record<string, unknown> = {}) => registry(cfg).entry("voice.provider");

  it.each([["elevenlabs", "ElevenLabs"], ["fish", "Fish Audio"], ["xai", "xAI"], ["gemini", "Gemini"], ["openai", "OpenAI"], ["deepseek", "DeepSeek"]])(
    "waits for a tap that names %s when the text would go there", (provider, name) => {
      const current = provider === "system" ? {} : { tts: { provider: "system" } };
      expect(entry(current).confirm?.(provider)).toEqual({ code: "dataTo", params: { provider: name } });
    });

  it("applies at once for system and chatterbox, and when the provider stays the same", () => {
    expect(entry({ tts: { provider: "fish" } }).confirm?.("system")).toBeNull();
    expect(entry({ tts: { provider: "fish" } }).confirm?.("chatterbox")).toBeNull();
    expect(entry({ tts: { provider: "fish" } }).confirm?.("fish")).toBeNull();
    expect(entry().confirm?.("elevenlabs")).toBeNull();
  });

  it("uses a card line that exists for the dataTo code", () => {
    expect(consequenceKey("dataTo")).toBe("server.appSettings.confirm.dataTo");
  });

  it("saves only the provider for a bot's change, so the server resets voice and model", async () => {
    const fx = registry({ tts: { provider: "elevenlabs", voice: "v1", model: "m1" } });
    await fx.entry("voice.provider").write("gemini");
    expect(fx.saved).toEqual([{ tts: { provider: "gemini" } }]);
  });

  it("puts back the provider, the voice and the model on Undo", async () => {
    const fx = registry({ tts: { provider: "elevenlabs", voice: "v1", model: "m1" } });
    const before = fx.entry("voice.provider").current("gemini");
    expect(before).toEqual({ provider: "elevenlabs", voice: "v1", model: "m1" });
    await fx.entry("voice.provider").write(before);
    expect(fx.saved).toEqual([{ tts: { provider: "elevenlabs", voice: "v1", model: "m1" } }]);
  });

  it("reads ElevenLabs, and empty voice and model, when nothing is saved", () => {
    const fx = registry({});
    expect(fx.entry("voice.provider").read()).toBe("elevenlabs");
    expect(fx.entry("voice.provider").current("system")).toEqual({ provider: "elevenlabs", voice: "", model: "" });
  });

  it("accepts a provider name or the Undo object, and nothing else", () => {
    const { value } = entry();
    expect(value.safeParse("deepseek").success).toBe(true);
    expect(value.safeParse({ provider: "fish", voice: "", model: "" }).success).toBe(true);
    expect(value.safeParse("azure").success).toBe(false);
  });

  it("lists the choices and what each needs, with no key value", () => {
    const fx = registry({ tts: { key: "env-secret", provider: "elevenlabs" } });
    const more = fx.entry("voice.provider").more!();
    expect(JSON.stringify(more)).not.toContain("env-secret");
    expect(more.providers).toMatchObject({ elevenlabs: "needs keys.ttsKey", fish: "needs keys.fishAudioKey", chatterbox: "needs voice.baseUrl" });
    const ids = new Set(fx.entries.map((one) => one.id));
    for (const need of ["keys.ttsKey", "keys.fishAudioKey", "keys.geminiTtsKey", "keys.xaiApiKey", "keys.openaiApiKey", "keys.deepseekApiKey", "voice.baseUrl"]) expect(ids.has(need), need).toBe(true);
  });
});

describe("the approval history setting (AC-04 to AC-06)", () => {
  const entry = (decisions?: { retentionDays?: number }) => registry(decisions ? { decisions } : {}).entry("decisions.retentionDays");

  it("waits for a tap only when it keeps fewer days than now", () => {
    expect(entry().confirm?.(30)).toEqual({ code: "deletesHistory", params: { days: "30" } });
    expect(entry().confirm?.(180)).toBeNull();
    expect(entry().confirm?.(365)).toBeNull();
    expect(entry({ retentionDays: 90 }).confirm?.(60)).toEqual({ code: "deletesHistory", params: { days: "60" } });
    expect(entry({ retentionDays: 90 }).confirm?.(90)).toBeNull();
    expect(entry({ retentionDays: 90 }).confirm?.(120)).toBeNull();
  });

  it("compares with the days the server's setup fixes", () => {
    process.env[PIN] = "400";
    expect(entry({ retentionDays: 30 }).confirm?.(365)).toEqual({ code: "deletesHistory", params: { days: "365" } });
    expect(entry({ retentionDays: 30 }).read()).toBe("400 days");
  });

  it("refuses in one line without a variable name when the setup fixes the days", () => {
    process.env[PIN] = "400";
    const refusal = entry().describe?.(30) as { refusal: string };
    expect(refusal.refusal).toMatch(/fixed by this server's setup/);
    expect(refusal.refusal).not.toMatch(/SEIRA|env/i);
    delete process.env[PIN];
    expect(entry().describe?.(30)).toEqual({ change: "Keep approval history for 30 days" });
  });

  it("writes only the days, and Undo of an unset value clears the saved number", async () => {
    const fx = registry({});
    const before = fx.entry("decisions.retentionDays").current(30);
    expect(before).toBeNull();
    await fx.entry("decisions.retentionDays").write(30);
    await fx.entry("decisions.retentionDays").write(before as never);
    expect(fx.saved).toEqual([{ decisions: { retentionDays: 30 } }, { decisions: { retentionDays: null } }]);
  });

  it("keeps a saved value for Undo", () => {
    expect(entry({ retentionDays: 90 }).current(30)).toBe(90);
  });

  it("accepts whole days from 1 to 3650", () => {
    const { value } = entry();
    expect([1, 3650].every((days) => value.safeParse(days).success)).toBe(true);
    expect([0, 3651, 1.5, "30"].some((days) => value.safeParse(days).success)).toBe(false);
  });
});

describe("the memory upkeep setting (AC-07)", () => {
  const upkeep = (memory?: Record<string, number>) => registry(memory ? { memory } : {}).entry("memory.upkeep");

  it("accepts values inside the bounds", () => {
    const { value } = upkeep();
    expect(value.safeParse({ captureQuietMs: 1000 }).success).toBe(true);
    expect(value.safeParse({ captureQuietMs: 86_400_000, tidyHour: 23 }).success).toBe(true);
    expect(value.safeParse({ tidyHour: 0 }).success).toBe(true);
  });

  it("refuses values outside the bounds, an empty object and unknown fields", () => {
    const { value } = upkeep();
    for (const bad of [{}, { captureQuietMs: 999 }, { captureQuietMs: 86_400_001 }, { tidyHour: 24 }, { tidyHour: -1 }, { tidyHour: 1.5 }, { other: 1 }]) expect(value.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("does not wait for a tap, and says what changes in plain words", () => {
    const entry = upkeep();
    expect(entry.confirm).toBeUndefined();
    expect(entry.describe?.({ captureQuietMs: 300_000, tidyHour: 4 })).toEqual({ change: "Bots note new facts after a conversation is quiet for 5 minutes; bots tidy memory at 04:00" });
    expect(entry.describe?.({ tidyHour: 4 })).toEqual({ change: "Bots tidy memory at 04:00" });
  });

  it("writes only the named fields", async () => {
    const fx = registry({});
    await fx.entry("memory.upkeep").write({ tidyHour: 5 });
    expect(fx.saved).toEqual([{ memory: { tidyHour: 5 } }]);
  });

  it("gives null for each unset field, so Undo clears it", async () => {
    const fx = registry({ memory: { tidyHour: 2 } });
    const before = fx.entry("memory.upkeep").current({ captureQuietMs: 5000 });
    expect(before).toEqual({ captureQuietMs: null, tidyHour: 2 });
    await fx.entry("memory.upkeep").write(before as never);
    expect(fx.saved).toEqual([{ memory: { captureQuietMs: null, tidyHour: 2 } }]);
  });

  it("reads minutes and the tidy hour, with the defaults when unset", () => {
    expect(upkeep().read()).toBe("2 minutes quiet, tidy at 03:00");
    expect(upkeep({ captureQuietMs: 600_000, tidyHour: 22 }).read()).toBe("10 minutes quiet, tidy at 22:00");
  });
});

describe("the treg key card (AC-08)", () => {
  it("is a secret entry in Apps that reads as set only once a key is saved", () => {
    const empty = registry({});
    const secret = empty.entries.find((one) => one.id === "keys.tregApiKey");
    expect(secret).toMatchObject({ tier: "secret", credentialId: "tregApiKey", where: "apps", label: "treg key" });
    expect(secret?.read()).toBe("");
    expect(registry({ treg: { key: "env-treg" } }).entries.find((one) => one.id === "keys.tregApiKey")?.read()).toBe("set");
  });

  it("saves into the treg section and counts as configured", () => {
    expect(credentialConfigPatch("tregApiKey", "x")).toEqual({ treg: { key: "x" } });
    expect(credentialIsConfigured({ treg: { key: "x" } }, "tregApiKey")).toBe(true);
    expect(credentialIsConfigured({}, "tregApiKey")).toBe(false);
  });
});
