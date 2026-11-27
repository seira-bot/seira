import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import { createAppSettings } from "./host.ts";
import { createSettingsRegistry, type RegistryDeps } from "./registry.ts";

const PRIVATE_KEY = "sk-pool-0a1b2c3d4e5f";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Pool = NonNullable<AppConfig["aiPool"]>;
const ENGINES: ReturnType<NonNullable<RegistryDeps["poolEngines"]>> = [
  { instanceId: "claude", name: "Claude", model: "claude-sonnet", billing: "plan" },
  { instanceId: "codex", name: "Codex", model: "gpt-5", billing: "plan" },
  { instanceId: "openai-compat-gw", name: "Gateway", model: "gw-large", billing: "pay per use" },
  { instanceId: "mystery", name: "Mystery", model: "m-1", billing: "unknown" },
];

function fixture(options: { owner?: boolean; guest?: boolean; pool?: Pool; engines?: typeof ENGINES } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "ai-pool-"));
  dirs.push(dataDir);
  const bots = [{ id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi" } as unknown as BotRecord];
  const cfg = { language: "en", openai: { key: PRIVATE_KEY }, ...(options.pool ? { aiPool: options.pool } : {}) } as unknown as AppConfig;
  const saved: Record<string, unknown>[] = [];
  const messages: Array<Record<string, any>> = [];
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${messages.length + 1}`, threadId };
      messages.push(row);
      return row as never;
    },
    bot: (id: string) => bots.find((bot) => bot.id === id),
    messagesFor: (threadId: string) => messages.filter((message) => message.threadId === threadId) as never,
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      Object.assign(messages.find((message) => message.threadId === threadId && message.id === messageId)!, patch);
      return null;
    },
  };
  const entries = createSettingsRegistry({
    cfg: () => cfg,
    saveConfig: async (patch: Record<string, unknown>) => { saved.push(patch); Object.assign(cfg, structuredClone(patch)); return null; },
    bots: () => bots, sections: () => [], credentials: () => cfg, paused: () => [],
    window: { read: () => undefined, write: () => null },
    engines: () => [], poolEngines: () => options.engines ?? ENGINES,
  } as unknown as RegistryDeps);
  const host = createAppSettings({
    store: store as never, dataDir, entries,
    asker: () => (options.owner === false ? { kind: "refused", code: "not-owner" } : { kind: "clean" }),
    guestDriven: () => options.guest === true,
    requestCredential: async () => ({ status: 500, body: {} }),
    connectorThread: () => null,
    language: () => undefined,
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const set = (value: unknown) => host.handle({ action: "set", id: "ai.pool", value: JSON.stringify(value) }, turn);
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  const undo = () => host.undo({ threadId: turn.threadId, requestId: String(cards().at(-1)!.card.requestId) });
  return { host, cfg, saved, turn, set, cards, undo };
}

const claudeCodex = [{ instanceId: "claude", model: "claude-sonnet" }, { instanceId: "codex", model: "gpt-5" }];
const onPool: Pool = { enabled: true, mode: "even", members: claudeCodex, levels: [80, 60], floor: 10 };

describe("the AI pool setting", () => {
  it("AC-01: find returns ai.pool as a safe setting with its current value", async () => {
    const { host, turn } = fixture({ pool: { enabled: true, mode: "turns", members: claudeCodex } });
    const found = await host.handle({ action: "find", query: "ai pool" }, turn);
    const hits = JSON.parse(String(found.body.text)) as Array<Record<string, unknown>>;
    expect(hits[0]).toEqual({ id: "ai.pool", label: "AI pool", tier: "safe", value: "on, Take turns: Claude (claude-sonnet), Codex (gpt-5)", where: "Settings → AI → AI pool → Share usage across AIs" });
    expect(JSON.parse(String((await fixture().host.handle({ action: "find", query: "ai pool" }, turn)).body.text))[0].value).toBe("off");
  });

  it("AC-02: get lists each signed-in AI with id, model, name and billing, and no key", async () => {
    const { host, turn } = fixture();
    const got = await host.handle({ action: "get", id: "ai.pool" }, turn);
    const body = JSON.parse(String(got.body.text)) as { help: string };
    expect(body.help).toContain("Claude (id claude, model claude-sonnet, plan)");
    expect(body.help).toContain("Codex (id codex, model gpt-5, plan)");
    expect(body.help).toContain("Gateway (id openai-compat-gw, model gw-large, pay per use)");
    expect(body.help).toContain("Mystery (id mystery, model m-1, unknown)");
    expect(String(got.body.text)).not.toContain(PRIVATE_KEY);
    expect(String(got.body.text)).not.toMatch(/sk-/);
  });

  it("AC-03: the owner's own turn turns the pool on through the config route, with one applied card and Undo", async () => {
    const { set, saved, cfg, cards } = fixture();
    const answer = await set({ enabled: true, mode: "turns", members: claudeCodex });
    expect(answer.status).toBe(200);
    expect(saved).toEqual([{ aiPool: { enabled: true, mode: "turns", members: claudeCodex } }]);
    expect(cfg.aiPool).toEqual({ enabled: true, mode: "turns", members: claudeCodex });
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.card).toMatchObject({ subtitle: "Turn on the AI pool: Take turns, Claude and Codex", answered: "allow", autoApplied: true });
    expect(String(answer.body.text)).toContain("undo");
  });

  it("AC-04: setting only the mode, or only the members, keeps every other saved field", async () => {
    const mode = fixture({ pool: onPool });
    expect((await mode.set({ mode: "inOrder" })).status).toBe(200);
    expect(mode.cfg.aiPool).toEqual({ ...onPool, mode: "inOrder" });
    const members = fixture({ pool: onPool });
    const reversed = [...claudeCodex].reverse();
    expect((await members.set({ members: reversed })).status).toBe(200);
    expect(members.cfg.aiPool).toEqual({ ...onPool, members: reversed });
  });

  it("AC-05: a pay-per-use AI, an AI with unknown billing, or an AI that is gone is refused and nothing is saved", async () => {
    for (const bad of ["openai-compat-gw", "mystery", "gone"]) {
      const { set, saved, cfg } = fixture();
      const answer = await set({ enabled: true, members: [claudeCodex[0], { instanceId: bad, model: "x" }] });
      expect(answer.status, bad).toBe(409);
      expect(String(answer.body.error), bad).toContain("Only the person adds");
      expect(String(answer.body.error), bad).toContain("show_card");
      expect(String(answer.body.error), bad).toContain("ai-pool");
      expect(saved, bad).toEqual([]);
      expect(cfg.aiPool, bad).toBeUndefined();
    }
  });

  it("AC-05: turning on a saved pool that already holds a pay-per-use AI is refused", async () => {
    const pool: Pool = { enabled: false, mode: "even", members: [claudeCodex[0]!, { instanceId: "openai-compat-gw", model: "gw-large" }] };
    const { set, saved, cfg } = fixture({ pool });
    const answer = await set({ enabled: true });
    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toContain("ai-pool");
    expect(saved).toEqual([]);
    expect(cfg.aiPool).toEqual(pool);
  });

  it("AC-05: turning the pool off stays possible when it holds a pay-per-use AI", async () => {
    const pool: Pool = { enabled: true, mode: "even", members: [claudeCodex[0]!, { instanceId: "openai-compat-gw", model: "gw-large" }] };
    const { set, cfg } = fixture({ pool });
    expect((await set({ enabled: false })).status).toBe(200);
    expect(cfg.aiPool).toEqual({ ...pool, enabled: false });
  });

  it("AC-06: turning on with fewer than two members is refused and names the AIs the bot can add", async () => {
    const { set, saved, cfg } = fixture();
    for (const value of [{ enabled: true }, { enabled: true, members: [claudeCodex[0]] }]) {
      const answer = await set(value);
      expect(answer.status).toBe(409);
      expect(String(answer.body.error)).toContain("at least two");
      expect(String(answer.body.error)).toContain("Claude (id claude, model claude-sonnet)");
      expect(String(answer.body.error)).toContain("Codex (id codex, model gpt-5)");
      expect(String(answer.body.error)).not.toContain("Gateway");
    }
    expect(saved).toEqual([]);
    expect(cfg.aiPool).toBeUndefined();
  });

  it("AC-07: Undo restores the pool saved before the change, with no field left behind", async () => {
    const { set, undo, cfg } = fixture();
    await set({ enabled: true, members: claudeCodex, levels: [70, 40] });
    expect(cfg.aiPool).toMatchObject({ levels: [70, 40] });
    expect(await undo()).toEqual({ claimed: true, state: "undone" });
    expect(cfg.aiPool).toEqual({ enabled: false, mode: "even", members: [] });
    const withLevels = fixture({ pool: onPool });
    await withLevels.set({ mode: "turns" });
    expect(await withLevels.undo()).toEqual({ claimed: true, state: "undone" });
    expect(withLevels.cfg.aiPool).toEqual(onPool);
  });

  it("AC-09: a turn that is not the owner's own is refused with 403 and nothing is saved", async () => {
    for (const options of [{ owner: false }, { guest: true }]) {
      const { set, saved, cfg } = fixture(options);
      expect((await set({ enabled: true, members: claudeCodex })).status).toBe(403);
      expect(saved).toEqual([]);
      expect(cfg.aiPool).toBeUndefined();
    }
  });

  it("refuses a value with no field, an unknown field or a key", async () => {
    const { set, saved } = fixture();
    for (const value of [{}, { surprise: 1 }, { members: [{ instanceId: "claude", model: "m", key: PRIVATE_KEY }] }, { mode: "random" }]) {
      expect((await set(value)).status).toBe(400);
    }
    expect(saved).toEqual([]);
  });
});
