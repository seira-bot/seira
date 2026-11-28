import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_FEATURES } from "../../shared/app-features.ts";
import type { AppConfig } from "../config.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import { closedByStop } from "../host/resumable-cards.ts";
import type { BotRecord } from "../store.ts";
import { appSettingDecisionText, CONFIRM_MS, createAppSettings, OPEN_CARD_LIMIT, WRITE_BUDGET } from "./host.ts";
import { createSettingsRegistry } from "./registry.ts";
import type { SettingsVerdict } from "./verdict.ts";

const OPENAI_KEY = "sk-live-9f8e7d6c5b4a3210";
const GATEWAY_KEY = "sk-gateway-0a1b2c3d";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture(options: { owner?: boolean; verdict?: SettingsVerdict; guest?: boolean; group?: boolean; window?: boolean; pictureRefusal?: string; patchRefusal?: string; automated?: boolean; resumes?: boolean; threadRefusal?: (threadId: string, mode: string) => string | null; people?: { place?: "desktop" | "team" | "cloud-home" | "server"; email?: boolean; accessRefusal?: string } } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "app-settings-"));
  dirs.push(dataDir);
  const bots: BotRecord[] = [
    { id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi", approvalMode: "full", section: "Sales", modelSelection: { instanceId: "claude", model: "opus" } } as unknown as BotRecord,
    { id: "clive", name: "Clive", color: "blue", threadId: "t-clive", approvalMode: "ask", modelSelection: { instanceId: "claude", model: "sonnet" }, assignedSkills: ["notes"] } as unknown as BotRecord,
  ];
  const cfg = { language: "en", rooms: { turnTimeoutMinutes: 30 }, mcp: {}, threads: { maxConcurrentPerBot: 3 }, openai: { key: OPENAI_KEY }, anthropic: { url: "https://api.anthropic.com" },
    instances: { "openai-compat-gw": { driver: "openai-compat", displayName: "Gateway", config: { key: GATEWAY_KEY, url: "https://gw.example/v1" } } } } as unknown as AppConfig;
  if (options.people) (cfg as { signIn?: unknown }).signIn = { admins: ["boss@acme.com"], members: ["ann@acme.com"] };
  const grants: Record<string, { departments: Array<{ name: string; level: string }>; bots: Array<{ id: string; level: string }> }> = {};
  const engineCalls: unknown[] = [];
  const engines = [{ instanceId: "claude", name: "Claude", working: true }, { instanceId: "openai-compat-gw", name: "Gateway", working: true }];
  const botPatches: Array<{ botId: string; body: Record<string, unknown> }> = [];
  const threads: Record<string, Record<string, string>> = { kiwi: { "t-kiwi": "full", "t-kiwi-2": "full" }, clive: { "t-clive": "ask", "t-clive-2": "ask" } };
  const routeCalls: unknown[] = [];
  const saved: Record<string, unknown>[] = [];
  const order: string[] = [];
  const messages: Array<Record<string, any>> = [];
  const windowValues = new Map<string, unknown>(options.window === false ? [] : [["appearance.skin", "daylight"]]);
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${messages.length + 1}`, threadId };
      messages.push(row);
      return row as never;
    },
    bot: (id: string) => bots.find((bot) => bot.id === id),
    messagesFor: (threadId: string) => messages.filter((message) => message.threadId === threadId) as never,
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      const row = messages.find((message) => message.threadId === threadId && message.id === messageId);
      if (row) Object.assign(row, patch);
      return null;
    },
  };
  const credentialCards: Record<string, unknown>[] = [];
  const pictureFiles: { taken: string[]; discarded: string[] } = { taken: [], discarded: [] };
  const entries = createSettingsRegistry({
    cfg: () => cfg,
    saveConfig: async (patch) => {
      if (patch.anthropic && typeof patch.anthropic === "object" && (patch.anthropic as { url?: string }).url === "https://refused.example") return "the provider refused it";
      saved.push(patch);
      order.push("lists");
      Object.assign(cfg, patch);
      return null;
    },
    bots: () => bots,
    sections: () => ["Sales"],
    reorderBots: async (botIds) => { bots.sort((a, b) => botIds.indexOf(a.id) - botIds.indexOf(b.id)); return null; },
    patchBot: async (botId, body) => {
      if (options.patchRefusal) return options.patchRefusal;
      botPatches.push({ botId, body });
      Object.assign(bots.find((bot) => bot.id === botId)!, body);
      if (body.applyToAllThreads) for (const id of Object.keys(threads[botId]!)) threads[botId]![id] = String(body.approvalMode);
      return null;
    },
    threadModes: (botId) => ({ ...threads[botId] }) as never,
    threadModeRefusal: (_botId, threadId, mode) => options.threadRefusal?.(threadId, mode) ?? null,
    setThreadModes: async (botId, modes) => {
      const unknown = Object.keys(modes).find((id) => !(id in threads[botId]!));
      if (unknown) return `no conversation ${unknown}`;
      Object.assign(threads[botId]!, modes);
      return null;
    },
    call: async (route, method, path, body) => {
      routeCalls.push({ route, method, path, body });
      order.push("access");
      if (route === "departmentAccess" && options.people?.accessRefusal) return options.people.accessRefusal;
      if (route === "departmentAccess") {
        const entry = String(body?.entry);
        if (body?.access) grants[entry] = body.access as never;
        else delete grants[entry];
      }
      return null;
    },
    read: async (_route, path) => (path === "/api/skills-library" ? { skills: [{ name: "notes", enabled: false, everyBot: false }] } : null),
    paused: () => [],
    pinBot: async (botId, pinned) => { (bots.find((bot) => bot.id === botId) as { pinned?: boolean }).pinned = pinned || undefined; return null; },
    groupBots: async (name, botIds) => { for (const bot of bots) if (botIds.includes(bot.id)) (bot as { section?: string }).section = name || undefined; return null; },
    credentials: () => cfg,
    window: {
      read: (id) => windowValues.get(id),
      write: (id, value) => { if (!windowValues.size) return "Open Seira on this computer first."; windowValues.set(id, value); return null; },
    },
    engines: () => engines,
    addEngine: async (path, body) => {
      engineCalls.push({ add: path, body });
      const instanceId = `openai-compat-${engines.length}`;
      engines.push({ instanceId, name: String(body.displayName), working: true });
      (cfg.instances as Record<string, unknown>)[instanceId] = { driver: "openai-compat", displayName: body.displayName, config: { url: body.url, key: body.key } };
      return null;
    },
    removeEngine: async (instanceId) => { engineCalls.push({ remove: instanceId }); engines.splice(engines.findIndex((engine) => engine.instanceId === instanceId), 1); return null; },
    imageReady: (provider) => provider === "openai",
    people: { place: () => options.people?.place ?? "server", emailSignIn: () => options.people?.email !== false, publicUrl: () => "https://team.example.org", grants: () => grants as never },
  });
  const clock = { at: 1_700_000_000_000 };
  const resumed: Array<{ threadId: string; messageId: string; text: string }> = [];
  const verdict = { current: options.verdict ?? (options.owner === false ? { kind: "refused", code: "not-owner" } as SettingsVerdict : { kind: "clean" } as SettingsVerdict) };
  const build = () => createAppSettings({
    store: store as never, dataDir, entries,
    asker: () => verdict.current,
    now: () => clock.at,
    resume: (threadId, messageId, text) => { resumed.push({ threadId, messageId, text }); return options.resumes === true; },
    guestDriven: () => options.guest === true,
    automated: () => options.automated === true,
    requestCredential: async (_bot, _threadId, body) => { credentialCards.push(body); return { status: 201, body: { messageId: "secret-1", label: "OpenAI API key" } }; },
    connectorThread: () => ({ group: options.group ? { id: "g", name: "Room" } as never : undefined }),
    language: () => undefined,
    pictures: {
      take: async (_turn, path) => {
        pictureFiles.taken.push(path);
        return options.pictureRefusal ? { refusal: options.pictureRefusal } : { avatarUrl: `/api/attachments/stored-${pictureFiles.taken.length}.png` };
      },
      discard: (avatarUrl) => { pictureFiles.discarded.push(avatarUrl); },
    },
  });
  const host = build();
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const set = (id: string, value?: unknown, generation = turn.generation) => host.handle({ action: "set", id, ...(value === undefined ? {} : { value }) }, { ...turn, generation });
  const cards = () => messages.filter((message) => message.card?.appSettingRequest);
  /** Undo on the newest applied card. */
  const undo = () => host.undo({ threadId: turn.threadId, requestId: String(cards().at(-1)!.card.requestId) });
  const waiting = () => cards().filter((message) => !message.card.autoApplied && !message.card.answered && !message.card.dismissed && !message.card.expired);
  const resolve = async (requestId: string, behavior: "allow" | "deny", ownerReview = true) => (await host.resolve({ threadId: turn.threadId, requestId, behavior, ownerReview }))!;
  /** Sets the value and taps Apply on the card it posts. */
  const setAndApply = async (id: string, value?: unknown) => {
    const posted = await set(id, value);
    const card = cards().at(-1)!.card;
    return { posted, applied: await resolve(String(card.requestId), "allow"), requestId: String(card.requestId) };
  };
  const decisions = async () => { await flushDecisionLog(dataDir); return readDecisions(dataDir, 100); };
  return { host, build, threads, cfg, saved, messages, cards, waiting, resolve, setAndApply, decisions, clock, resumed, verdict, credentialCards, windowValues, bots, turn, set, undo, dataDir, engineCalls, botPatches, routeCalls, engines, pictureFiles, grants, order };
}

describe("a set to the value the setting already has", () => {
  it("says so, and posts no change card, no Undo and no decision-log line", async () => {
    const { set, cards, messages, windowValues, dataDir } = fixture();
    const answer = await set("appearance.skin", "daylight");
    expect(answer.status).toBe(200);
    expect(String(answer.body.text)).toBe("Skin already is daylight. Nothing changed, so no card was shown.");
    expect(windowValues.get("appearance.skin")).toBe("daylight");
    expect(cards()).toEqual([]);
    expect(messages).toEqual([]);
    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10)).toEqual([]);
  });

  it("still posts the card and the log line when the value changes", async () => {
    const { set, cards } = fixture();
    expect((await set("appearance.skin", "midnight")).status).toBe(200);
    expect(cards()).toHaveLength(1);
  });
});

describe("reads", () => {
  it("find lists matches with tier, value and where; get adds help and allowed values", async () => {
    const { host, turn } = fixture();
    const found = await host.handle({ action: "find", query: "dark mode" }, turn);
    const hits = JSON.parse(String(found.body.text)) as Array<Record<string, unknown>>;
    expect(hits[0]).toMatchObject({ id: "appearance.skin", tier: "safe", value: "daylight", where: "Settings → Appearance → Theme" });
    const got = await host.handle({ action: "get", id: "rooms.turnTimeoutMinutes" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ id: "rooms.turnTimeoutMinutes", value: "30", allowed: "1 to 1440 minutes", change: "set applies at once, with Undo on the card" });
  });

  it("names real places only: find falls back to where a thing is, places lists them all", async () => {
    const { host, turn } = fixture();
    const owner = await host.handle({ action: "get", id: "phone.pairing" }, turn);
    expect(JSON.parse(String(owner.body.text))).toMatchObject({ where: "Settings → Phone & devices → Pair a phone", change: "only the person, in Settings → Phone & devices → Pair a phone" });
    const none = await host.handle({ action: "find", query: "invoice" }, turn);
    expect(none.body.text).toMatch(/^No setting you can change matches "invoice"\. Where the person finds it in the app: Settings → Plan & billing/);
    expect((await host.handle({ action: "places", query: "spending" }, turn)).body.text).toMatch(/^Settings → Spending \(shown in Advanced mode only/);
    const every = String((await host.handle({ action: "places" }, turn)).body.text).split("\n");
    expect(every[0]).toMatch(/^Settings opens from/);
    expect(every).toContain("Settings → AI → Other services. Id for show_place: keys.");
    expect(every.join("\n")).not.toMatch(/API keys|Computers\b/);
  });

  it("places searches the UI map beside Settings, and on no match says so without listing any menu", async () => {
    const { host, turn } = fixture();
    const found = String((await host.handle({ action: "places", query: "where is the calendar" }, turn)).body.text);
    expect(found).toContain("Calendar: top right of the Automations page");
    expect(found).toContain("Clicks: Click Automations in the sidebar → Click Calendar");
    const none = String((await host.handle({ action: "places", query: "quantum flux capacitor" }, turn)).body.text);
    expect(none).toMatch(/^No place in the app matches "quantum flux capacitor"\./);
    expect(none).toContain("do not name a menu");
    expect(none).not.toMatch(/Settings →|Automations|Sidebar/);
    expect(none.split("\n")).toHaveLength(1);
    const every = String((await host.handle({ action: "places" }, turn)).body.text);
    expect(every).toContain("query");
  });

  it("places only reads: it sends no change to the app", async () => {
    const { host, turn } = fixture();
    const before = JSON.stringify(await host.handle({ action: "get", id: "appearance.skin" }, turn));
    await host.handle({ action: "places", query: "board" }, turn);
    expect(JSON.stringify(await host.handle({ action: "get", id: "appearance.skin" }, turn))).toBe(before);
  });

  it("features answers with each match's name, place, what it does and tools, and lists them all with no words", async () => {
    const { host, turn } = fixture();
    const found = await host.handle({ action: "features", query: "workflow" }, turn);
    expect(found.status).toBe(200);
    const lines = String(found.body.text).split("\n");
    expect(lines[0]).toMatch(/^Workflows — Automations → Workflows: .*only when a routine uses it/);
    const routines = String((await host.handle({ action: "features", query: "routine" }, turn)).body.text);
    expect(routines).toMatch(/^Automations — .*\(tools: trigger_info, trigger, delete_trigger\)/m);
    const none = String((await host.handle({ action: "features", query: "zzzzqq" }, turn)).body.text);
    expect(none).toMatch(/^No feature of the app matches "zzzzqq"\. Here is every feature:\n/);
    const every = String((await host.handle({ action: "features" }, turn)).body.text).split("\n");
    expect(every).toContain("Workflows — Automations → Workflows");
    expect(every.length).toBe(APP_FEATURES.length);
  });

  it("works in a turn that is not the owner's, where writes are refused", async () => {
    const { host, turn, set, saved } = fixture({ owner: false });
    expect((await host.handle({ action: "get", id: "general.language" }, turn)).status).toBe(200);
    const refused = await set("general.language", "de");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("did not come from the owner");
    expect(saved).toEqual([]);
  });

  it("refuses writes in a guest-driven conversation", async () => {
    const { set, saved } = fixture({ guest: true });
    expect((await set("general.language", "de")).status).toBe(403);
    expect(saved).toEqual([]);
  });

  it("refuses an unknown id and a value the schema rejects", async () => {
    const { set, saved } = fixture();
    expect((await set("nope.nothing", 1)).status).toBe(404);
    const bad = await set("rooms.turnTimeoutMinutes", 100_000);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("1 to 1440 minutes");
    expect(saved).toEqual([]);
  });
  it("reads numbers and JSON lists from the text the tool sends", async () => {
    const { set, saved } = fixture();
    expect((await set("rooms.turnTimeoutMinutes", "45")).status).toBe(200);
    expect((await set("rooms.turnTimeoutMinutes", "lots")).status).toBe(400);
    expect(saved).toHaveLength(1);
  });
});

describe("safe tier", () => {
  it("applies at once, posts an applied card with Undo, and logs a decision", async () => {
    const { set, saved, cards, dataDir } = fixture();
    const result = await set("rooms.turnTimeoutMinutes", 45);
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Changed Room turn timeout from 30 to 45");
    expect(saved).toEqual([{ rooms: { turnTimeoutMinutes: 45 } }]);
    expect(cards()[0]!.card).toMatchObject({ autoApplied: true, answered: "allow", options: [], tool: "app_settings", appSettingRequest: { settingId: "rooms.turnTimeoutMinutes", before: "30", after: "45", tier: "safe" } });
    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10)).toMatchObject([{ decision: "auto-approved", source: "app-settings", tool: "app_settings", summary: "rooms.turnTimeoutMinutes: 30 → 45", botId: "kiwi" }]);
  });

  it("undo restores the earlier value only while the current one is still the applied one", async () => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    await set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(cards()[0]!.card.requestId);
    cfg.rooms = { turnTimeoutMinutes: 60 };
    expect(await host.undo({ threadId: turn.threadId, requestId })).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
    cfg.rooms = { turnTimeoutMinutes: 45 };
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "undone" });
    expect(saved.at(-1)).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
    expect(cards()[0]!.card.undone).toBe(true);
    expect(await host.undo({ threadId: turn.threadId, requestId })).toEqual({ claimed: true, state: "already_undone" });
  });

  it("a setting never saved reads as the default the app runs on, so Undo of its first change sets that default back", async () => {
    const { host, set, cfg, cards, turn, saved } = fixture();
    delete cfg.rooms; delete cfg.threads; cfg.mcp = {};
    for (const [id, value] of [["rooms.turnTimeoutMinutes", 45], ["mcp.callTimeoutMinutes", 20], ["threads.maxConcurrentPerBot", 7]] as const) {
      const before = cards().length;
      expect((await set(id, value)).status).toBe(200);
      const card = cards()[before]!.card;
      expect(card.appSettingRequest.before, id).toMatch(/^\d+$/);
      expect(await host.undo({ threadId: turn.threadId, requestId: String(card.requestId) }), id).toEqual({ claimed: true, state: "undone" });
    }
    expect(saved.slice(-1)).toEqual([{ threads: { maxConcurrentPerBot: Number(cards()[2]!.card.appSettingRequest.before) } }]);
    expect(saved).toContainEqual({ rooms: { turnTimeoutMinutes: 5 } });
    expect(saved).toContainEqual({ mcp: { callTimeoutMinutes: 10 } });
  });

  it("reorders and groups bots through the registry, with typed values kept for undo", async () => {
    const { host, set, bots, cards, turn } = fixture();
    expect((await set("bots.order", ["clive", "kiwi"])).status).toBe(200);
    expect(bots.map((bot) => bot.id)).toEqual(["clive", "kiwi"]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(cards()[0]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(bots.map((bot) => bot.id)).toEqual(["kiwi", "clive"]);
    expect((await set("bots.groups", { Ops: ["clive"] })).status).toBe(200);
    expect(bots.map((bot) => bot.section)).toEqual([undefined, "Ops"]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(cards()[1]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(bots.map((bot) => bot.section)).toEqual(["Sales", undefined]);
  });

  it("pins and unpins bots from the full list sent, refuses an unknown id, and Undo restores the earlier pins", async () => {
    const { host, set, bots, cards, turn } = fixture();
    const pins = () => bots.filter((bot) => bot.pinned).map((bot) => bot.id);
    expect((await set("bots.pinned", JSON.stringify(["clive"]))).body.text).toMatch(/^Changed Pinned bots from not set to Clive\./);
    expect(pins()).toEqual(["clive"]);
    expect((await set("bots.pinned", ["kiwi"])).status).toBe(200);
    expect(pins()).toEqual(["kiwi"]);
    expect(await host.undo({ threadId: turn.threadId, requestId: String(cards()[1]!.card.requestId) })).toEqual({ claimed: true, state: "undone" });
    expect(pins()).toEqual(["clive"]);
    expect((await set("bots.pinned", ["ghost"])).body.error).toContain("No bot has the id ghost");
    expect(pins()).toEqual(["clive"]);
  });

  it("a window preference refuses until a window has reported, then pushes the change", async () => {
    const closed = fixture({ window: false });
    const refused = await closed.set("appearance.skin", "midnight");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Open Seira on this computer first");
    const open = fixture();
    expect((await open.set("appearance.skin", "midnight")).status).toBe(200);
    expect(open.windowValues.get("appearance.skin")).toBe("midnight");
    expect((await open.set("appearance.skin", "neon")).status).toBe(400);
  });

  it("AC-10 sets the text size to a step, says it in percent, and refuses a value that is not a step", async () => {
    const fx = fixture();
    const done = await fx.set("appearance.textSize", 1.5);
    expect(done.status).toBe(200);
    expect(done.body.text).toMatch(/^Done: Set the text size to 150 %\./);
    expect(fx.windowValues.get("appearance.textSize")).toBe(1.5);
    expect((await fx.set("appearance.textSize", 1.3)).status).toBe(400);
    expect((await fx.set("appearance.textSize", "big")).status).toBe(400);
    expect(fx.windowValues.get("appearance.textSize")).toBe(1.5);
  });

  it(`stops after ${WRITE_BUDGET} writes in one turn and allows the next turn`, async () => {
    const { set } = fixture();
    for (let index = 0; index < WRITE_BUDGET; index += 1) expect((await set("rooms.turnTimeoutMinutes", 10 + index)).status).toBe(200);
    const over = await set("rooms.turnTimeoutMinutes", 99);
    expect(over.status).toBe(429);
    expect(over.body.error).toContain(`${WRITE_BUDGET} settings`);
    expect((await set("rooms.turnTimeoutMinutes", 99, "gen-2")).status).toBe(200);
  });
});

describe("AI engines", () => {
  it("get lists the engines by id with no key, and find reaches them", async () => {
    const { host, turn } = fixture();
    const got = JSON.parse(String((await host.handle({ action: "get", id: "engines" }, turn)).body.text));
    expect(got).toMatchObject({ tier: "safe", value: "claude: Claude (removed only in Settings); openai-compat-gw: Gateway at https://gw.example/v1" });
    expect(JSON.stringify(got)).not.toContain(GATEWAY_KEY);
    const found = JSON.parse(String((await host.handle({ action: "find", query: "add ollama engine" }, turn)).body.text));
    expect(found[0].id).toBe("engines");
  });

  it("adds a local server at once with a card naming kind, name and address, and Undo removes it", async () => {
    const fx = fixture();
    const added = await fx.set("engines", JSON.stringify({ kind: "ollama", url: "http://127.0.0.1:11434" }));
    expect(added.body.text).toMatch(/^Done: Add the engine "Ollama" \(Ollama on http:\/\/127\.0\.0\.1:11434\)\. AI engines now: .*The user can undo it/);
    expect(fx.engineCalls).toEqual([{ add: "openai-compat", body: { displayName: "Ollama", url: "http://127.0.0.1:11434", key: "ollama", catalog: "ollama" } }]);
    expect(fx.cards()[0]!.card).toMatchObject({ title: "Changed AI engines", subtitle: "Add the engine \"Ollama\" (Ollama on http://127.0.0.1:11434)", options: [], autoApplied: true,
      appSettingRequest: { settingId: "engines", tier: "safe", after: "Add the engine \"Ollama\" (Ollama on http://127.0.0.1:11434)" } });
    expect(fx.cards()[0]!.card.appSettingRequest).not.toHaveProperty("before");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.engineCalls.at(-1)).toEqual({ remove: "openai-compat-2" });
    expect(fx.engines.map((engine) => engine.instanceId)).toEqual(["claude", "openai-compat-gw"]);
  });

  it("refuses a local server already added at the same address, so Settings never lists it twice", async () => {
    const fx = fixture();
    await fx.set("engines", JSON.stringify({ kind: "lmstudio", url: "http://127.0.0.1:1234/v1" }));
    const again = await fx.set("engines", JSON.stringify({ kind: "lmstudio", url: "http://127.0.0.1:1234/v1/" }));
    expect(again).toMatchObject({ status: 409, body: { error: "\"LM Studio\" at http://127.0.0.1:1234/v1 is already an engine (openai-compat-2). Use that one; do not add it again." } });
    expect(fx.engineCalls).toHaveLength(1);
    expect(fx.cards()).toHaveLength(1);
    // Another address is another server.
    await fx.set("engines", JSON.stringify({ kind: "lmstudio", url: "http://127.0.0.1:1235/v1" }));
    expect(fx.engineCalls).toHaveLength(2);
  });

  it("an engine that needs a key takes only a saved key's id, which the server reads as it adds it; the key is shown nowhere", async () => {
    const fx = fixture();
    const missing = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "mistralApiKey" }));
    expect(missing).toMatchObject({ status: 409, body: { error: "Your Mistral API key is not saved yet. Call set on keys.mistralApiKey with no value first (a secure card asks the user for it), then add the engine." } });
    for (const field of ["key", "apiKey", "token"]) {
      const inline = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", [field]: OPENAI_KEY }));
      expect(inline.status, field).toBe(400);
      expect(inline.body.error, field).toContain("Never put a key or token in the value");
    }
    expect(fx.cards()).toEqual([]);
    const result = await fx.set("engines", JSON.stringify({ kind: "openai-compat", name: "Proxy", url: "https://proxy.example/v1", keyFrom: "openaiApiKey" }));
    expect(fx.cards()[0]!.card.subtitle).toMatch(/^Add the engine "Proxy" \(OpenAI-compatible\) at https:\/\/proxy\.example\/v1, sending it your saved OpenAI API key\n.*proxy\.example/);
    expect(fx.engineCalls).toEqual([]);
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(fx.engineCalls).toEqual([{ add: "openai-compat", body: { displayName: "Proxy", url: "https://proxy.example/v1", key: OPENAI_KEY } }]);
    await flushDecisionLog(fx.dataDir);
    expect(JSON.stringify([missing, result, fx.messages, readDecisions(fx.dataDir, 20)])).not.toContain(OPENAI_KEY);
  });

  it("never removes an engine: the bot is told in one line that the person does that in Settings", async () => {
    const fx = fixture();
    const refused = await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "openai-compat-gw" }));
    expect(refused).toMatchObject({ status: 409, body: { error: "Removing an AI engine is changed only by the person, in Settings → AI → Providers. Tell them where in one line; do not try another way." } });
    expect(fx.engineCalls).toEqual([]);
    expect(fx.cards()).toEqual([]);
  });
});

describe("secret tier", () => {
  it("never takes a value, posts the secret card instead, and shows keys only as set or not set", async () => {
    const { host, set, credentialCards, messages, turn, dataDir } = fixture();
    const withValue = await set("keys.openaiApiKey", OPENAI_KEY);
    expect(withValue.status).toBe(400);
    expect(credentialCards).toEqual([]);
    const carded = await set("keys.openaiApiKey");
    expect(carded.status).toBe(200);
    expect(credentialCards).toEqual([{ credentialId: "openaiApiKey", reason: undefined }]);
    const got = await host.handle({ action: "get", id: "keys.openaiApiKey" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "secret", value: "set" });
    const found = await host.handle({ action: "find", query: "anthropic key" }, turn);
    expect(JSON.parse(String(found.body.text))).toContainEqual(expect.objectContaining({ id: "keys.anthropicApiKey", value: "not set" }));
    await flushDecisionLog(dataDir);
    const everything = JSON.stringify([withValue, carded, got, found, messages, readDecisions(dataDir, 10)]);
    expect(everything).not.toContain(OPENAI_KEY);
  });
});

describe("owner-only tier", () => {
  it("explains and refuses with where to change it: sign-in, logins, pairing, backups, the domain", async () => {
    const { host, set, turn, cards, saved, routeCalls } = fixture();
    const got = await host.handle({ action: "get", id: "vault.logins" }, turn);
    expect(JSON.parse(String(got.body.text))).toMatchObject({ tier: "owner-only", change: "only the person, in Settings → Vault" });
    for (const id of ["cloud.account", "vault.logins", "phone.pairing", "data.backups", "remote.domain", "remote.httpsAddress"]) {
      const refused = await set(id, "on");
      expect(refused.status, id).toBe(403);
      expect(refused.body.error, id).toMatch(/ is changed only by the person, in Settings → .+\. Tell them where in one line; do not try another way\.$/);
    }
    expect([cards(), saved, routeCalls]).toEqual([[], [], []]);
  });

  it("turns a way in to this computer on after the owner's tap, with Undo, but leaves turning one off to the person", async () => {
    const fx = fixture();
    fx.windowValues.set("remote.relay", false);
    const on = await fx.set("remote.relay", "true");
    expect(on.body.text).toContain("Nothing has changed yet");
    expect(fx.windowValues.get("remote.relay")).toBe(false);
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(fx.windowValues.get("remote.relay")).toBe(true);
    const off = await fx.set("remote.relay", false);
    expect(off).toMatchObject({ status: 409, body: { error: "Turning off Reach from anywhere is changed only by the person, in Settings → Phone & devices → How your phone reaches this computer → Anywhere, through Seira (only in the desktop app, on this computer's own page). Tell them where in one line; do not try another way." } });
    expect(fx.windowValues.get("remote.relay")).toBe(true);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.windowValues.get("remote.relay")).toBe(false);
  });
});

describe("people who sign in", () => {
  const lists = (fx: ReturnType<typeof fixture>) => (fx.cfg as { signIn?: { admins: string[]; members: string[] } }).signIn;

  it("invites a person as a user of the whole team only after the admin taps Apply", async () => {
    const fx = fixture({ people: {} });
    const posted = await fx.set("people.signIn", { email: "New@Acme.com" });
    expect(String(posted.body.text)).toContain("Nothing has changed yet");
    expect(lists(fx)!.members).toEqual(["ann@acme.com"]);
    const card = fx.cards().at(-1)!.card;
    expect(card.appSettingRequest).toMatchObject({ settingId: "people.signIn", consequence: "new@acme.com can sign in and sees the whole team." });
    expect(card.subtitle).toContain("Invite new@acme.com as user, sees the whole team. They sign in at https://team.example.org.");
    expect(fx.routeCalls).toEqual([]);
    await fx.resolve(String(card.requestId), "allow");
    expect(lists(fx)).toEqual({ admins: ["boss@acme.com"], members: ["ann@acme.com", "new@acme.com"] });
    expect(fx.routeCalls).toEqual([]);
  });

  it("gives a person chosen departments and bots through the access route, and Undo sets the earlier state back", async () => {
    const fx = fixture({ people: {} });
    await fx.set("people.signIn", { email: "pat@acme.com", sees: { departments: ["sales"], bots: ["Clive"] } });
    expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("pat@acme.com can sign in and sees only: Sales, Clive.");
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(lists(fx)!.members).toContain("pat@acme.com");
    expect(fx.routeCalls).toEqual([{ route: "departmentAccess", method: "PUT", path: "/api/department-access", body: {
      entry: "pat@acme.com", admitBots: true, access: { departments: [{ name: "Sales", level: "chat" }], bots: [{ id: "clive", level: "chat" }] } } }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(lists(fx)!.members).not.toContain("pat@acme.com");
    expect(fx.grants["pat@acme.com"]).toBeUndefined();
  });

  it("changes only what is named: a person keeps their role when the bot changes their access", async () => {
    const fx = fixture({ people: {} });
    await fx.set("people.signIn", { email: "ann@acme.com", sees: { departments: ["Sales"] } });
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(fx.saved).toEqual([]);
    expect(fx.grants["ann@acme.com"]).toEqual({ departments: [{ name: "Sales", level: "chat" }], bots: [] });
    const again = await fx.set("people.signIn", { email: "ann@acme.com", sees: { departments: ["Sales"] } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("ann@acme.com already has this.");
  });

  it("keeps a department's view level through a role change, and writes no access when only the role changes", async () => {
    const fx = fixture({ people: {} });
    fx.grants["ann@acme.com"] = { departments: [{ name: "Sales", level: "view" }], bots: [] };
    await fx.set("people.signIn", { email: "ann@acme.com", role: "admin" });
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    await fx.set("people.signIn", { email: "ann@acme.com", role: "user" });
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(lists(fx)!.members).toContain("ann@acme.com");
    expect(fx.routeCalls).toEqual([]);
    expect(fx.grants["ann@acme.com"]).toEqual({ departments: [{ name: "Sales", level: "view" }], bots: [] });
  });

  it("restores the exact earlier access, levels included, when Undo follows an access change", async () => {
    const fx = fixture({ people: {} });
    const earlier = { departments: [{ name: "Sales", level: "view" }], bots: [{ id: "clive", level: "view" }] };
    fx.grants["ann@acme.com"] = JSON.parse(JSON.stringify(earlier));
    await fx.set("people.signIn", { email: "ann@acme.com", sees: { departments: [{ name: "Sales", level: "chat" }] } });
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(fx.grants["ann@acme.com"]).toEqual({ departments: [{ name: "Sales", level: "chat" }], bots: [] });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.grants["ann@acme.com"]).toEqual(earlier);
  });

  it("keeps the level of a department already granted and gives a new one chat", async () => {
    const fx = fixture({ people: {} });
    fx.grants["ann@acme.com"] = { departments: [{ name: "Sales", level: "view" }], bots: [] };
    await fx.set("people.signIn", { email: "ann@acme.com", sees: { departments: ["Sales", "General"] } });
    expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("ann@acme.com can sign in and sees only: Sales (view only), General.");
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(fx.grants["ann@acme.com"]).toEqual({ departments: [{ name: "Sales", level: "view" }, { name: "", level: "chat" }], bots: [] });
  });

  it("makes a person an admin with a card that says what an admin can do, and leaves their access as it was", async () => {
    const fx = fixture({ people: {} });
    fx.grants["ann@acme.com"] = { departments: [{ name: "Sales", level: "chat" }], bots: [] };
    await fx.set("people.signIn", { email: "ann@acme.com", role: "admin" });
    expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("ann@acme.com can sign in as an admin and change every setting on this server.");
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(lists(fx)).toEqual({ admins: ["boss@acme.com", "ann@acme.com"], members: [] });
    expect(fx.routeCalls).toEqual([]);
  });

  it("removes a person and their limits, and Undo brings both back", async () => {
    const fx = fixture({ people: {} });
    fx.grants["ann@acme.com"] = { departments: [{ name: "Sales", level: "chat" }], bots: [] };
    await fx.set("people.signIn", { email: "ann@acme.com", role: "none" });
    expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("ann@acme.com can no longer sign in. Anyone who is signed in now is signed out.");
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(lists(fx)).toEqual({ admins: ["boss@acme.com"], members: [] });
    expect(fx.grants["ann@acme.com"]).toBeUndefined();
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(lists(fx)).toEqual({ admins: ["boss@acme.com"], members: ["ann@acme.com"] });
    expect(fx.grants["ann@acme.com"]).toEqual({ departments: [{ name: "Sales", level: "chat" }], bots: [] });
  });

  it("writes nothing when the one who taps Apply is no admin", async () => {
    const fx = fixture({ people: {} });
    await fx.set("people.signIn", { email: "new@acme.com" });
    const denied = await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow", false);
    expect(denied.status).toBe(403);
    expect(lists(fx)!.members).toEqual(["ann@acme.com"]);
    expect(fx.routeCalls).toEqual([]);
    expect(fx.saved).toEqual([]);
  });

  it("saves a new person's limits before the list lets them in, and a removal or promotion after the list", async () => {
    const fx = fixture({ people: {} });
    await fx.set("people.signIn", { email: "pat@acme.com", sees: { bots: ["Clive"] } });
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(fx.order).toEqual(["access", "lists"]);
    fx.order.length = 0;
    await fx.set("people.signIn", { email: "pat@acme.com", role: "none" });
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(fx.order).toEqual(["lists", "access"]);
  });

  it("leaves the sign-in lists as they were when the access change is refused", async () => {
    const fx = fixture({ people: { accessRefusal: "That bot is shared with too many people already." } });
    await fx.set("people.signIn", { email: "pat@acme.com", sees: { bots: ["Clive"] } });
    const applied = await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(applied.body.error).toBe("The change could not be applied. Nothing changed.");
    expect(fx.cards().at(-1)!.card.appSettingRequest.result).toBe("failed");
    expect(lists(fx)).toEqual({ admins: ["boss@acme.com"], members: ["ann@acme.com"] });
    expect(fx.order).toEqual(["access"]);
  });

  it("treats a grant with nothing left as no access: no card says the whole team, and Undo of a role change keeps it empty", async () => {
    const fx = fixture({ people: {} });
    const NOTHING = { departments: [], bots: [] };
    fx.grants["ann@acme.com"] = { ...NOTHING };
    await fx.set("people.signIn", { email: "ann@acme.com", role: "admin" });
    expect(fx.cards().at(-1)!.card.subtitle).toContain("Change ann@acme.com as admin.");
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect((await fx.set("people.signIn", { email: "ann@acme.com", role: "user" })).body.error)
      .toBe("ann@acme.com would see nothing. Name what ann@acme.com should see, or give the whole team.");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(lists(fx)).toEqual({ admins: ["boss@acme.com"], members: ["ann@acme.com"] });
    expect(fx.grants["ann@acme.com"]).toEqual(NOTHING);
    expect(fx.routeCalls).toEqual([]);
  });

  it("refuses an Undo that would give more than nothing back to a person whose grant had nothing left", async () => {
    const fx = fixture({ people: {} });
    fx.grants["ann@acme.com"] = { departments: [], bots: [] };
    await fx.set("people.signIn", { email: "ann@acme.com", sees: { departments: ["Sales"] } });
    expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("ann@acme.com can sign in and sees only: Sales.");
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", error: expect.stringMatching(/^ann@acme\.com saw nothing before this change, so Undo cannot set that back\. Choose what ann@acme\.com sees in Settings → /) });
    expect(fx.grants["ann@acme.com"]).toEqual({ departments: [{ name: "Sales", level: "chat" }], bots: [] });
    expect(lists(fx)!.members).toContain("ann@acme.com");
  });

  it("refuses the only admin's removal, an unknown department or bot, an empty choice and a domain with bots", async () => {
    const fx = fixture({ people: {} });
    const refused = async (value: unknown) => (await fx.set("people.signIn", value)).body.error;
    expect(await refused({ email: "boss@acme.com", role: "none" })).toMatch(/^This is the only admin\./);
    expect(await refused({ email: "x@acme.com", sees: { departments: ["Nope"] } })).toBe("No department is named Nope. The departments are: General, Sales.");
    expect(await refused({ email: "x@acme.com", sees: { bots: ["Nobody"] } })).toBe("No bot is named Nobody. Use list_bots for the names.");
    expect(await refused({ email: "x@acme.com", sees: {} })).toBe("Choose at least one department or bot, or give the whole team.");
    expect(await refused({ email: "@acme.com", sees: { bots: ["Clive"] } })).toBe("To give access to chosen bots, invite each person by their own address.");
    expect(await refused({ email: "not an address" })).toBe("Enter an email address or @domain.");
    expect(fx.cards()).toEqual([]);
    expect([lists(fx), fx.routeCalls]).toEqual([{ admins: ["boss@acme.com"], members: ["ann@acme.com"] }, []]);
  });

  describe("an address under an @domain rule", () => {
    const withDomain = (signIn: { admins: string[]; members: string[] }, grants: Record<string, unknown> = {}) => {
      const fx = fixture({ people: {} });
      (fx.cfg as { signIn?: unknown }).signIn = signIn;
      Object.assign(fx.grants, grants);
      return fx;
    };
    const SALES_ONLY = { departments: [{ name: "Sales", level: "chat" }], bots: [] };

    it("refuses a user role that an admin @domain would override, and a removal that an @domain would undo", async () => {
      const fx = withDomain({ admins: ["boss@acme.com", "@boss.test"], members: ["kim@boss.test", "@corp.test", "lee@corp.test"] });
      const refused = async (value: unknown) => (await fx.set("people.signIn", value)).body.error;
      expect(await refused({ email: "kim@boss.test", role: "user", sees: { departments: ["Sales"] } }))
        .toBe("kim@boss.test would still sign in as an admin, because everyone at @boss.test is an admin. Change @boss.test first.");
      expect(await refused({ email: "new@boss.test" })).toBe("new@boss.test would still sign in as an admin, because everyone at @boss.test is an admin. Change @boss.test first.");
      expect(await refused({ email: "lee@corp.test", role: "none" })).toBe("lee@corp.test would still sign in, because everyone at @corp.test may sign in. Remove @corp.test first.");
      expect(await refused({ email: "zed@corp.test", role: "none" })).toBe("zed@corp.test is not on the list on their own: everyone at @corp.test may sign in. Remove @corp.test to stop that.");
      expect(await refused({ email: "@corp.test", role: "none" })).toMatch(/^Some addresses at @corp\.test are on the list on their own and would still sign in\. Remove them first, or remove @corp\.test in Settings → /);
      expect(fx.cards()).toEqual([]);
      expect(fx.saved).toEqual([]);
      expect(fx.routeCalls).toEqual([]);
    });

    it("names the @domain's access on the card when the person keeps none of their own, and refuses a whole team the domain would limit", async () => {
      const fx = withDomain({ admins: ["boss@acme.com"], members: ["@corp.test"] }, { "@corp.test": SALES_ONLY });
      expect((await fx.set("people.signIn", { email: "new@corp.test", sees: "whole team" })).body.error)
        .toBe("new@corp.test would see only what everyone at @corp.test sees, not the whole team. Name what new@corp.test should see, or change @corp.test first.");
      await fx.set("people.signIn", { email: "new@corp.test" });
      expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("new@corp.test can sign in and sees only: Sales.");
      await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(lists(fx)!.members).toEqual(["@corp.test", "new@corp.test"]);
      expect(fx.routeCalls).toEqual([]);
    });

    it("lets Undo put the entries back even where the @domain still admits the person", async () => {
      const fx = withDomain({ admins: ["boss@acme.com"], members: ["@corp.test"] }, { "@corp.test": SALES_ONLY });
      await fx.set("people.signIn", { email: "new@corp.test", sees: { departments: ["General"] } });
      expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("new@corp.test can sign in and sees only: General.");
      await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(fx.grants["new@corp.test"]).toEqual({ departments: [{ name: "", level: "chat" }], bots: [] });
      expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
      expect(lists(fx)).toEqual({ admins: ["boss@acme.com"], members: ["@corp.test"] });
      expect(fx.grants["new@corp.test"]).toBeUndefined();
      expect(fx.grants["@corp.test"]).toEqual(SALES_ONLY);
    });

    it("keeps the level a person has through their @domain when the bot names a department without one", async () => {
      const SALES_VIEW = { departments: [{ name: "Sales", level: "view" }], bots: [] };
      const fx = withDomain({ admins: ["boss@acme.com"], members: ["@corp.test"] }, { "@corp.test": SALES_VIEW });
      await fx.set("people.signIn", { email: "new@corp.test" });
      expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("new@corp.test can sign in and sees only: Sales (view only).");
      await fx.set("people.signIn", { email: "pat@corp.test", sees: { departments: ["Sales", "General"] } });
      expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("pat@corp.test can sign in and sees only: Sales (view only), General.");
      await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(fx.grants["pat@corp.test"]).toEqual({ departments: [{ name: "Sales", level: "view" }, { name: "", level: "chat" }], bots: [] });
    });

    it("refuses to invite a person who would see nothing because their @domain's grant has nothing left", async () => {
      const fx = withDomain({ admins: ["boss@acme.com"], members: ["@corp.test"] }, { "@corp.test": { departments: [], bots: [] } });
      expect((await fx.set("people.signIn", { email: "new@corp.test" })).body.error)
        .toBe("new@corp.test would see nothing. Name what new@corp.test should see, or give the whole team.");
      expect(fx.cards()).toEqual([]);
    });

    it("refuses Apply as stale when the @domain's role or access changed after the card was shown", async () => {
      const fx = withDomain({ admins: ["boss@acme.com"], members: ["@corp.test"] }, { "@corp.test": SALES_ONLY });
      await fx.set("people.signIn", { email: "new@corp.test" });
      fx.grants["@corp.test"] = { departments: [{ name: "", level: "chat" }], bots: [] };
      const accessMoved = await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(accessMoved.status).toBe(409);
      expect(fx.cards().at(-1)!.card.appSettingRequest).toMatchObject({ result: "stale" });

      await fx.set("people.signIn", { email: "pat@corp.test", sees: { departments: ["Sales"] } });
      (fx.cfg as { signIn?: unknown }).signIn = { admins: ["boss@acme.com", "@corp.test"], members: [] };
      const roleMoved = await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(roleMoved.status).toBe(409);
      expect(fx.cards().at(-1)!.card.appSettingRequest).toMatchObject({ result: "stale" });
      expect(fx.saved).toEqual([]);
      expect(fx.routeCalls).toEqual([]);
    });

    it("names the role rule and the access rule apart on an @domain's card", async () => {
      const fx = withDomain({ admins: ["boss@acme.com"], members: ["@corp.test", "lee@corp.test"] });
      await fx.set("people.signIn", { email: "@corp.test", sees: { departments: ["Sales"] } });
      const card = fx.cards().at(-1)!.card;
      expect(card.appSettingRequest.consequence).toBe("Anyone with an address at @corp.test can sign in, not only one person.");
      expect(card.subtitle).toContain("Change @corp.test as user, sees only Sales. 1 address at @corp.test is on the list on its own as a user. Everyone at @corp.test sees what is named above.");

      // lee is an admin on their own: their grant changes nothing, and the domain's access does not bind them.
      const mixed = withDomain(
        { admins: ["boss@acme.com", "lee@corp.test"], members: ["@corp.test", "kim@corp.test", "LEE@corp.test"] },
        { "kim@corp.test": SALES_ONLY, "zed@corp.test": SALES_ONLY, "lee@corp.test": SALES_ONLY },
      );
      await mixed.set("people.signIn", { email: "@corp.test", sees: { departments: ["General"] } });
      expect(mixed.cards().at(-1)!.card.subtitle).toContain("Change @corp.test as user, sees only General. "
        + "1 address at @corp.test is an admin on its own and sees everything. 1 address at @corp.test is on the list on its own as a user. "
        + "2 addresses at @corp.test have access of their own and keep it. "
        + "Everyone at @corp.test who is not an admin and has no access of their own sees what is named above.");
    });

    it("refuses an @domain card's Apply as stale once an address under it gets its own entry, access or role", async () => {
      const fx = withDomain({ admins: ["boss@acme.com"], members: ["@corp.test"] });
      await fx.set("people.signIn", { email: "@corp.test", sees: { departments: ["Sales"] } });
      fx.grants["pat@corp.test"] = SALES_ONLY;
      const granted = await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(granted.status).toBe(409);
      expect(fx.cards().at(-1)!.card.appSettingRequest).toMatchObject({ result: "stale" });

      await fx.set("people.signIn", { email: "@corp.test", sees: { departments: ["General"] } });
      (fx.cfg as { signIn?: { members: string[] } }).signIn!.members.push("kim@corp.test");
      const listed = await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(listed.status).toBe(409);
      expect(fx.cards().at(-1)!.card.appSettingRequest).toMatchObject({ result: "stale" });

      // Same number of entries, another role: kim moves from user to admin, so the card's admin note is wrong.
      await fx.set("people.signIn", { email: "@corp.test", sees: { departments: ["Sales"] } });
      (fx.cfg as { signIn?: unknown }).signIn = { admins: ["boss@acme.com", "kim@corp.test"], members: ["@corp.test"] };
      const promoted = await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
      expect(promoted.status).toBe(409);
      expect(fx.cards().at(-1)!.card.appSettingRequest).toMatchObject({ result: "stale" });
      expect(fx.routeCalls).toEqual([]);
    });
  });

  it("refuses on the app's own computer, a Team, My Cloud and a server with no email sign-in, with a plain reason and no card", async () => {
    for (const people of [{ place: "desktop" }, { place: "team" }, { place: "cloud-home" }, { email: false }] as const) {
      const fx = fixture({ people });
      const refused = await fx.set("people.signIn", { email: "new@acme.com" });
      expect(refused.status).toBe(409);
      expect(String(refused.body.error)).not.toMatch(/Settings →|\/api|signIn|cfg/);
      expect(fx.cards()).toEqual([]);
      expect(fx.routeCalls).toEqual([]);
    }
  });

  it("refuses to make a whole @domain an admin, and says a domain invite lets anyone at it in", async () => {
    const fx = fixture({ people: {} });
    const refused = await fx.set("people.signIn", { email: "@acme.com", role: "admin" });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/^A bot cannot make a whole @domain an admin\. The person does that in Settings → People/);
    expect(fx.cards()).toEqual([]);
    await fx.set("people.signIn", { email: "@acme.com" });
    expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("Anyone with an address at @acme.com can sign in, not only one person.");
    await fx.set("people.signIn", { email: "@other.com", sees: { departments: ["Sales"] } });
    expect(fx.cards().at(-1)!.card.appSettingRequest.consequence).toBe("Anyone with an address at @other.com can sign in, not only one person.");
  });

  it("gives no bot or department name to a get, which runs before any check", async () => {
    const fx = fixture({ people: {} });
    const got = await fx.host.handle({ action: "get", id: "people.signIn" }, fx.turn);
    expect(JSON.stringify(got.body)).not.toMatch(/Kiwi|Clive|Sales|acme/);
    expect(JSON.stringify(got.body)).toContain("roles");
  });

  it("reads as counts, never as addresses", async () => {
    const fx = fixture({ people: {} });
    const got = await fx.host.handle({ action: "get", id: "people.signIn" }, fx.turn);
    expect(JSON.stringify(got.body)).not.toMatch(/@acme\.com/);
    expect(JSON.stringify(got.body)).toContain("1 admin, 1 other entry");
  });
});

describe("pictures from a file the bot names", () => {
  const MASCOT = { avatarUrl: null, avatarCrop: "mascot", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 };

  it("gives a bot the stored picture in a circle, with Undo back to its mascot face", async () => {
    const fx = fixture();
    const done = await fx.set("bots.picture", JSON.stringify({ botId: "clive", path: "/work/clive.png" }));
    expect(done.body.text).toBe("Done: Give Clive the picture clive.png. Bot picture now: Kiwi: mascot face; Clive: /api/attachments/stored-1.png. The user can undo it from the card in the conversation.");
    expect(fx.pictureFiles.taken).toEqual(["/work/clive.png"]);
    expect(fx.botPatches).toEqual([{ botId: "clive", body: { avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "circle", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 } }]);
    expect(fx.cards()[0]!.card).toMatchObject({ subtitle: "Give Clive the picture clive.png", appSettingRequest: { settingId: "bots.picture", after: "Give Clive the picture clive.png" } });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches[1]).toEqual({ botId: "clive", body: { ...MASCOT, avatarUrl: null } });
  });

  it("keeps a bot's own crop, takes a picture off with an empty path, and Undo puts the earlier picture back", async () => {
    const fx = fixture();
    Object.assign(fx.bots[0]!, { avatarUrl: "/api/attachments/earlier.webp", avatarCrop: "rounded", avatarZoom: 2 });
    await fx.set("bots.picture", { botId: "kiwi", path: "new.gif" });
    expect(fx.botPatches[0]!.body).toMatchObject({ avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "rounded", avatarZoom: 1 });
    const off = await fx.set("bots.picture", { botId: "kiwi", path: "" });
    expect(off.body.text).toMatch(/^Done: Take Kiwi's picture off; it shows its mascot face again\./);
    expect(fx.botPatches[1]!.body).toEqual(MASCOT);
    expect(fx.pictureFiles.taken).toEqual(["new.gif"]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches[2]!.body).toEqual({ avatarUrl: "/api/attachments/stored-1.png", avatarCrop: "rounded", avatarZoom: 1, avatarFocusX: 0.5, avatarFocusY: 0.5 });
    expect(await fx.set("bots.picture", { botId: "clive", path: "" })).toMatchObject({ status: 409, body: { error: "Clive has no picture; it already shows its mascot face." } });
  });

  it("sets and takes off the person's photo through the config route, with Undo", async () => {
    const fx = fixture();
    const done = await fx.set("profile.photo", { path: "/work/me.jpg" });
    expect(done.body.text).toMatch(/^Done: Make me\.jpg your photo\. Your photo now: \/api\/attachments\/stored-1\.png\./);
    expect(fx.saved).toEqual([{ profile: { avatarUrl: "/api/attachments/stored-1.png" } }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved[1]).toEqual({ profile: { avatarUrl: "" } });
    expect(await fx.set("profile.photo", { path: "" })).toMatchObject({ status: 409, body: { error: "The person has no photo to take off." } });
  });

  it("stores nothing when the turn may not change settings, the bot is unknown or the file is refused", async () => {
    const notOwner = fixture({ owner: false });
    expect((await notOwner.set("bots.picture", { botId: "kiwi", path: "a.png" })).status).toBe(403);
    expect((await notOwner.set("profile.photo", { path: "a.png" })).status).toBe(403);
    expect(notOwner.pictureFiles.taken).toEqual([]);

    const fx = fixture({ pictureRefusal: "a.png is not a PNG, JPEG, GIF or WebP picture." });
    expect(await fx.set("bots.picture", { botId: "nobody", path: "a.png" })).toMatchObject({ status: 409, body: { error: "No bot has the id nobody. Use list_bots for the ids." } });
    expect(await fx.set("bots.picture", { botId: "kiwi", path: "a.png" })).toEqual({ status: 400, body: { error: "a.png is not a PNG, JPEG, GIF or WebP picture." } });
    expect(await fx.set("bots.picture", { botId: "kiwi", avatarUrl: "/api/attachments/x.png" })).toMatchObject({ status: 400 });
    expect([fx.botPatches, fx.saved, fx.cards()]).toEqual([[], [], []]);
  });

  it("takes back the stored copy when the route refuses the change", async () => {
    const fx = fixture({ patchRefusal: "avatarUrl must reference an existing stored image" });
    expect(await fx.set("bots.picture", { botId: "kiwi", path: "a.png" })).toEqual({ status: 409, body: { error: "avatarUrl must reference an existing stored image" } });
    expect(fx.pictureFiles.discarded).toEqual(["/api/attachments/stored-1.png"]);
    expect(fx.cards()).toEqual([]);
  });
});

describe("every other setting applies at once with Undo, Full access or not", () => {
  const written = (fx: ReturnType<typeof fixture>) => JSON.stringify([fx.botPatches, fx.saved, fx.routeCalls, [...fx.windowValues]]);

  it.each([
    ["a bot's own setting", "bots.name", { botId: "clive", name: "Clover" }, "Rename Clive to \"Clover\"",
      (fx: ReturnType<typeof fixture>) => expect(fx.botPatches).toEqual([{ botId: "clive", body: { name: "Clover" } }, { botId: "clive", body: { name: "Clive" } }])],
    ["a server setting", "profile.name", "Ada", "not set → Ada", (fx: ReturnType<typeof fixture>) => expect(fx.saved).toEqual([{ profile: { name: "Ada" } }, { profile: { name: "" } }])],
    ["a provider model name", "providers.openaiCompat.model", "gpt-x", "not set → gpt-x",
      (fx: ReturnType<typeof fixture>) => expect(fx.saved).toEqual([{ openaiCompat: { model: "gpt-x" } }, { openaiCompat: { model: "" } }])],
    ["a library skill", "skills.library", { name: "notes", enabled: true }, "Turn on the library skill notes",
      (fx: ReturnType<typeof fixture>) => expect(fx.routeCalls).toEqual([{ route: "skills", method: "PATCH", path: "/api/skills-library/notes", body: { enabled: true } }, { route: "skills", method: "PATCH", path: "/api/skills-library/notes", body: { enabled: false } }])],
    ["a window preference", "general.openAtLogin", true, "Open Seira when you log in", (fx: ReturnType<typeof fixture>) => expect(fx.windowValues.get("general.openAtLogin")).toBe(false)],
  ])("%s applies with no card to answer, and Undo puts it back", async (_kind, id, value, subtitle, check) => {
    const fx = fixture();
    fx.windowValues.set("general.openAtLogin", false);
    const before = written(fx);
    const result = await fx.set(id, typeof value === "string" ? value : JSON.stringify(value));
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("The user can undo it from the card");
    expect(written(fx)).not.toBe(before);
    expect(fx.cards()[0]!.card).toMatchObject({ options: [], answered: "allow", autoApplied: true, subtitle, appSettingRequest: { settingId: id, tier: "safe" } });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    check(fx);
    await flushDecisionLog(fx.dataDir);
    expect(readDecisions(fx.dataDir, 10)).toMatchObject([{ decision: "auto-approved", source: "app-settings", tool: "app_settings", summary: expect.stringMatching(new RegExp(`^${id.replaceAll(".", "\\.")}: `)) }]);
  });

  it("a lower approval mode says what it allows and applies at once; Undo restores the earlier mode", async () => {
    const fx = fixture();
    const got = JSON.parse(String((await fx.host.handle({ action: "get", id: "bots.approvalModes" }, fx.turn)).body.text));
    expect(got).toMatchObject({ tier: "safe", value: "Kiwi: Full access; Clive: Ask for approval" });
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "ask" }))).status).toBe(200);
    expect(fx.cards()[0]!.card.subtitle).toBe("Make Kiwi ask you before each command or file change (Ask for approval)");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { approvalMode: "ask", applyToAllThreads: true } }, { botId: "kiwi", body: { approvalMode: "full" } }]);
  });

  it("refuses an unknown bot, an invalid mode, Custom, and Approve for me on this computer's own desktop", async () => {
    const fx = fixture();
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "ghost", mode: "ask" })))).toMatchObject({ status: 409, body: { error: "No bot has the id ghost. Use list_bots for the ids." } });
    expect((await fx.set("bots.name", JSON.stringify({ botId: "ghost", name: "Boo" }))).status).toBe(409);
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "clive", mode: "custom" }))).status).toBe(400);
    (fx.bots[1] as { computer?: string }).computer = "local";
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "clive", mode: "auto" }))).body.error).toMatch(/needs a warning only Clive's Settings shows/);
    expect((await fx.set("bots.model", JSON.stringify({ botId: "clive", instanceId: "nowhere", model: "x" }))).body.error).toContain("No engine has the id nowhere");
    expect(fx.cards()).toEqual([]);
    expect(fx.botPatches).toEqual([]);
  });

  it("never takes a key or token in a value", async () => {
    const fx = fixture();
    for (const [id, value] of [["bots.settings", { botId: "kiwi", apiKey: OPENAI_KEY }], ["ai.routing", { enabled: true, openrouterKey: OPENAI_KEY }], ["ai.images", { key: OPENAI_KEY }]] as const) {
      const refused = await fx.set(id, JSON.stringify(value));
      expect(refused.status, id).toBe(400);
      expect(refused.body.error, id).toContain("Never put a key or token in the value");
    }
    expect(fx.cards()).toEqual([]);
    expect(JSON.stringify(fx.messages)).not.toContain(OPENAI_KEY);
  });

  it("picks a custom decision endpoint with Undo, but never sets its address", async () => {
    const { set, saved } = fixture();
    expect((await set("ai.routing", JSON.stringify({ customModel: "m-1", customApi: "decisions" }))).status).toBe(200);
    expect(saved).toEqual([{ decider: { customModel: "m-1", customApi: "decisions" } }]);
    expect((await set("ai.routing", JSON.stringify({ customBaseUrl: "https://elsewhere.example.com" }))).status).toBe(400);
    expect(saved).toHaveLength(1);
  });

  it("a window preference is refused while no window is open, and nothing is posted", async () => {
    const fx = fixture({ window: false });
    expect((await fx.set("general.openAtLogin", true)).body.error).toContain("Open Seira on this computer first");
    expect(fx.cards()).toEqual([]);
    expect(fx.windowValues.size).toBe(0);
  });

  it("a browser profile is added naming whose browser it uses, never removed by a bot, and Undo takes the new one away", async () => {
    const fx = fixture();
    (fx.cfg as { browserProfiles?: unknown }).browserProfiles = [{ id: "work", name: "Work" }];
    expect((await fx.set("desktops.browserProfiles", JSON.stringify([]))).body.error).toMatch(/^Removing the browser profile "Work" deletes its saved logins/);
    expect(fx.cards()).toEqual([]);
    await fx.setAndApply("desktops.browserProfiles", JSON.stringify([{ id: "work", name: "Work" }, { name: "Mine", browser: "chrome" }]));
    expect(fx.cards()[0]!.card.subtitle).toBe("Browser profiles: add the profile \"Mine\" on your own running Chrome, with its logins");
    expect(fx.saved).toEqual([{ browserProfiles: [{ id: "work", name: "Work" }, { id: expect.stringMatching(/^profile-[0-9a-f]{32}$/), name: "Mine", browser: "chrome" }], expectedBrowserProfiles: [{ id: "work", name: "Work" }] }]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toMatchObject({ browserProfiles: [{ id: "work", name: "Work" }] });
  });

  it("other bot settings name each change, and Undo restores each field as the bot ran on it", async () => {
    const fx = fixture();
    await fx.set("bots.settings", JSON.stringify({ botId: "kiwi", memoryEnabled: false, computer: "vm" }));
    expect(fx.cards()[0]!.card.subtitle).toBe("Kiwi: memory off; computer use a private desktop on this computer");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { memoryEnabled: false, computer: "vm" } }, { botId: "kiwi", body: { memoryEnabled: true, computer: null } }]);
  });

  it("changes no setting from a routine or other automation, the owner's own included", async () => {
    const fx = fixture({ automated: true });
    for (const [id, value] of [["bots.settings", { botId: "kiwi", computer: "vm" }], ["rooms.turnTimeoutMinutes", 45]] as const) {
      const refused = await fx.set(id, JSON.stringify(value));
      expect(refused.status, id).toBe(403);
      expect(String(refused.body.error), id).toContain("A routine, webhook or other automation can't change settings. Nothing changed");
    }
    expect(fx.botPatches).toEqual([]);
    expect(fx.saved).toEqual([]);
    expect(fx.cards()).toEqual([]);
  });

  it("turns one bot's tool groups off and on by name, keeps the rest as they were, and Undo puts the list back", async () => {
    const fx = fixture();
    (fx.bots.find((bot) => bot.id === "kiwi") as { toolsOff?: string[] }).toolsOff = ["images"];
    await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["pages", "meetings"] }));
    expect(fx.cards()[0]!.card.subtitle).toBe("Kiwi: turn off Pages and apps, Meetings");
    await fx.setAndApply("bots.tools", JSON.stringify({ botId: "kiwi", turnOn: ["images"] }));
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches).toEqual([
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages", "images"] } },
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages"] } },
      { botId: "kiwi", body: { toolsOff: ["meetings", "pages", "images"] } },
    ]);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["browser"] }))).status).toBe(400);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi", turnOff: ["data"], turnOn: ["data"] }))).status).toBe(400);
    expect((await fx.set("bots.tools", JSON.stringify({ botId: "kiwi" }))).status).toBe(400);
  });

  it("the browser proxy takes only a socks5 address, reads as set or not set, and Undo clears it", async () => {
    const fx = fixture();
    expect((await fx.set("desktops.browserProxy", "http://proxy.example:8080")).status).toBe(400);
    const result = await fx.set("desktops.browserProxy", "socks5://proxy.example:1080");
    expect(result.body.text).toContain("Nothing has changed yet");
    expect(fx.saved).toEqual([]);
    await fx.resolve(String(fx.cards().at(-1)!.card.requestId), "allow");
    expect(JSON.stringify(fx.messages)).not.toContain("proxy.example");
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved).toEqual([{ browserEngine: { egress: { proxy: "socks5://proxy.example:1080" } } }, { browserEngine: { egress: { proxy: "" } } }]);
  });

  it("a bot's library skills are set from the full list, and Undo gives back the earlier list", async () => {
    const fx = fixture();
    await fx.set("bots.skills", JSON.stringify({ botId: "clive", skills: [] }));
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.routeCalls).toEqual([
      { route: "skills", method: "PUT", path: "/api/bots/clive/skills-library", body: { skills: [] } },
      { route: "skills", method: "PUT", path: "/api/bots/clive/skills-library", body: { skills: ["notes"] } },
    ]);
  });
});

const REFUSALS = [
  ["guest", { guest: true }],
  ["automation", { automated: true }],
  ["shared", { verdict: { kind: "refused", code: "shared" } }],
  ["unproven", { verdict: { kind: "refused", code: "unproven" } }],
  ["not-owner", { verdict: { kind: "refused", code: "not-owner" } }],
] as const;
const UP = JSON.stringify({ botId: "clive", mode: "full" });
const CONFIRM_HISTORY: SettingsVerdict = { kind: "confirm", why: "history" };

describe("settings changes judged on the turn's own request", () => {
  it("AC-01 applies a safe value at once for a clean request, with Undo on the card", async () => {
    const fx = fixture();
    const result = await fx.set("rooms.turnTimeoutMinutes", 45);
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Changed Room turn timeout from 30 to 45");
    expect(fx.saved).toEqual([{ rooms: { turnTimeoutMinutes: 45 } }]);
    expect(fx.cards()[0]!.card).toMatchObject({ autoApplied: true, answered: "allow", options: [] });
    expect(fx.waiting()).toEqual([]);
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
  });

  it.each([CONFIRM_HISTORY, { kind: "confirm", why: "shared" } as SettingsVerdict])("AC-02 posts a waiting card, not the change, when the verdict is confirm (%j)", async (verdict) => {
    const fx = fixture({ verdict });
    const result = await fx.set("rooms.turnTimeoutMinutes", 45);
    expect(result.status).toBe(200);
    expect(result.body.text).toContain("Nothing has changed yet");
    expect(fx.saved).toEqual([]);
    expect(fx.cfg.rooms).toEqual({ turnTimeoutMinutes: 30 });
    const card = fx.waiting()[0]!.card;
    expect(card).toMatchObject({ options: ["Apply", "Not now"], subtitle: "45", tool: "app_settings", fixedOptions: true, appSettingRequest: { settingId: "rooms.turnTimeoutMinutes", after: "45", expiresAt: fx.clock.at + CONFIRM_MS } });
    expect(card.appSettingRequest).not.toHaveProperty("before");
    expect(card).not.toHaveProperty("autoApplied");
    expect(card.appSettingRequest).not.toHaveProperty("consequence");
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "card-shown", source: "app-settings", requestId: card.requestId });
  });

  it("AC-02 changes the setting after Apply with the owner's review, and Undo is then on the card", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(fx.cards()[0]!.card.requestId);
    const answered = await fx.resolve(requestId, "allow");
    expect(answered).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once" } });
    expect(fx.saved).toEqual([{ rooms: { turnTimeoutMinutes: 45 } }]);
    expect(fx.cards()[0]!.card).toMatchObject({ autoApplied: true, answered: "allow", dismissed: true, options: [], appSettingRequest: { result: "applied", after: "45" } });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
  });

  it("AC-03 waits for a tap on more autonomy, naming the change and what follows from it", async () => {
    const fx = fixture();
    const result = await fx.set("bots.approvalModes", UP);
    expect(result.body.text).toContain("Nothing has changed yet");
    expect(fx.botPatches).toEqual([]);
    expect(fx.waiting()[0]!.card).toMatchObject({
      subtitle: "Let Clive act without asking (Full access)\nClive will do more without asking you first.",
      appSettingRequest: { after: "Let Clive act without asking (Full access)", consequence: "Clive will do more without asking you first." },
    });
    await fx.resolve(String(fx.cards()[0]!.card.requestId), "allow");
    expect(fx.botPatches).toEqual([{ botId: "clive", body: { approvalMode: "full", applyToAllThreads: true } }]);
  });

  it("AC-03 waits for a tap on a shorter log retention, showing before, after and what is deleted, and applies a longer one at once", async () => {
    const fx = fixture();
    await fx.set("threads.eventLogRetentionDays", 30);
    expect(fx.saved).toEqual([]);
    expect(fx.waiting()[0]!.card.appSettingRequest).toMatchObject({ before: "forever", after: "30", consequence: "Older conversation logs will be deleted. Undo can't bring them back." });
    await fx.resolve(String(fx.cards()[0]!.card.requestId), "allow");
    expect(fx.saved).toEqual([{ threads: { eventLogRetentionDays: 30 } }]);
    const longer = await fx.set("threads.eventLogRetentionDays", 60);
    expect(longer.body.text).toContain("Changed Thread log retention from 30 to 60");
    expect(fx.cards().at(-1)!.card).toMatchObject({ autoApplied: true, answered: "allow" });
  });

  it("AC-03 applies a lower approval mode at once", async () => {
    const fx = fixture();
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "edits" }))).body.text).toContain("Done:");
    expect(fx.waiting()).toEqual([]);
  });

  it("a bot on Full access with one conversation on Ask waits when set to Edits, because that conversation goes up", async () => {
    const fx = fixture();
    fx.threads.kiwi!["t-kiwi-2"] = "ask";
    const result = await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "edits" }));
    expect(result.body.text).toContain("Nothing has changed yet");
    expect(fx.waiting()[0]!.card.appSettingRequest).toMatchObject({ consequence: "Kiwi will do more without asking you first." });
    expect(fx.botPatches).toEqual([]);
  });

  it("a bot and all its conversations on Full access apply Edits at once", async () => {
    const fx = fixture();
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "edits" }))).body.text).toContain("Done:");
    expect(fx.waiting()).toEqual([]);
    expect(fx.threads.kiwi).toEqual({ "t-kiwi": "edits", "t-kiwi-2": "edits" });
  });

  it("Undo of an approval change puts each conversation back on its own mode", async () => {
    const fx = fixture();
    fx.threads.kiwi!["t-kiwi-2"] = "ask";
    expect((await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "ask" }))).body.text).toContain("Done:");
    expect(fx.threads.kiwi).toEqual({ "t-kiwi": "ask", "t-kiwi-2": "ask" });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.threads.kiwi).toEqual({ "t-kiwi": "full", "t-kiwi-2": "ask" });
    expect(fx.bots[0]).toMatchObject({ approvalMode: "full" });
  });

  it("Undo of an approval change is refused as stale when one conversation changed after the change", async () => {
    const fx = fixture();
    await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "ask" }));
    fx.threads.kiwi!["t-kiwi-2"] = "edits";
    expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", status: 409, stale: true });
    expect(fx.threads.kiwi).toEqual({ "t-kiwi": "ask", "t-kiwi-2": "edits" });
  });

  it("Apply of a raised approval mode is refused as stale when one conversation changed after the card", async () => {
    const fx = fixture();
    await fx.set("bots.approvalModes", UP);
    fx.threads.clive!["t-clive-2"] = "edits";
    const refused = await fx.resolve(String(fx.cards()[0]!.card.requestId), "allow");
    expect(refused.status).toBe(409);
    expect(fx.botPatches).toEqual([]);
    expect(fx.cards()[0]!.card.appSettingRequest).toMatchObject({ result: "stale" });
  });

  it("refuses a conversation map in a bot's own request, and writes nothing", async () => {
    const fx = fixture();
    const result = await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "ask", threads: { "t-kiwi-2": "full" } }));
    expect(result.status).toBe(400);
    expect(fx.botPatches).toEqual([]);
    expect(fx.cards()).toEqual([]);
  });

  it("refuses to change a bot that has a conversation on Custom approval", async () => {
    const fx = fixture();
    fx.threads.kiwi!["t-kiwi-2"] = "custom";
    const result = await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "ask" }));
    expect(result).toMatchObject({ status: 409, body: { error: expect.stringContaining("Kiwi has a conversation on Custom approval") } });
    expect(fx.botPatches).toEqual([]);
  });

  it("Undo is refused, and nothing changes, when a conversation would go to Full access where only the operator sets it", async () => {
    const fx = fixture({ threadRefusal: (_id, mode) => (mode === "full" ? "On a shared company workspace Full access comes only from the operator." : null) });
    await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "ask" }));
    const patches = fx.botPatches.length;
    const undone = await fx.undo();
    expect(undone).toMatchObject({ claimed: true, state: "invalid", status: 409, error: expect.stringContaining("Full access") });
    expect(fx.botPatches).toHaveLength(patches);
    expect(fx.threads.kiwi).toEqual({ "t-kiwi": "ask", "t-kiwi-2": "ask" });
    expect(fx.bots[0]).toMatchObject({ approvalMode: "ask" });
  });

  it("Undo is refused, and nothing changes, when a conversation would go to Approve for me on a bot that uses this computer's desktop", async () => {
    const fx = fixture({ threadRefusal: (_id, mode) => (mode === "auto" ? "Approve for me on this computer's own desktop needs a warning only the bot's Settings shows." : null) });
    fx.threads.kiwi!["t-kiwi-2"] = "auto";
    (fx.bots[0] as { approvalMode: string }).approvalMode = "auto";
    await fx.set("bots.approvalModes", JSON.stringify({ botId: "kiwi", mode: "ask" }));
    const patches = fx.botPatches.length;
    expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect(fx.botPatches).toHaveLength(patches);
    expect(fx.threads.kiwi).toEqual({ "t-kiwi": "ask", "t-kiwi-2": "ask" });
  });

  it("a rule of 4,000 characters waits on a card that holds the whole text, before and after", async () => {
    const fx = fixture();
    const earlier = `earlier ${"a".repeat(3000)}`;
    const proposed = `proposed ${"b".repeat(3991)}`;
    (fx.cfg as { everyBotRules?: string }).everyBotRules = earlier;
    await fx.set("bots.everyBotRules", proposed);
    const card = fx.waiting()[0]!.card;
    expect(proposed).toHaveLength(4000);
    expect(card.appSettingRequest).toMatchObject({ before: earlier, after: proposed });
    expect(card.subtitle).toContain(`${earlier}\n→\n${proposed}`);
    expect(fx.saved).toEqual([]);
    await fx.resolve(String(card.requestId), "allow");
    expect(fx.saved).toEqual([{ everyBotRules: proposed }]);
  });

  it("shows the old text only in the owner's own conversation, not in a room or a conversation someone else wrote into", async () => {
    const earlier = "EARLIER-SECRET-RULES";
    const proposed = "PROPOSED-RULES";
    const cases = [
      { name: "own", options: {}, shows: true },
      { name: "history", options: { verdict: CONFIRM_HISTORY }, shows: false },
      { name: "room", options: { group: true, verdict: CONFIRM_HISTORY }, shows: false },
    ];
    for (const { name, options, shows } of cases) {
      const fx = fixture(options);
      (fx.cfg as { everyBotRules?: string }).everyBotRules = earlier;
      (fx.cfg as { profile?: { aboutMe?: string } }).profile = { aboutMe: earlier };
      (fx.bots[0] as { soul?: string }).soul = earlier;
      await fx.set("bots.everyBotRules", proposed);
      await fx.set("profile.aboutMe", proposed);
      await fx.set("bots.settings", { botId: "kiwi", soul: proposed });
      expect(fx.waiting(), name).toHaveLength(3);
      for (const { card } of fx.waiting()) {
        expect(JSON.stringify(card).includes(earlier), name).toBe(shows);
        expect(JSON.stringify(card).includes(proposed), name).toBe(true);
        expect(Object.hasOwn(card.appSettingRequest, "before"), name).toBe(shows);
      }
    }
  });

  it("a card that leaves out the old value says so, and only the owner reads the full old and new text before Apply", async () => {
    const earlier = `earlier ${"e".repeat(592)}`;
    const proposed = `proposed ${"p".repeat(591)}`;
    expect(earlier).toHaveLength(600);
    for (const options of [{ verdict: CONFIRM_HISTORY }, { group: true, verdict: CONFIRM_HISTORY }, { group: true }]) {
      const fx = fixture(options);
      (fx.cfg as { everyBotRules?: string }).everyBotRules = earlier;
      await fx.set("bots.everyBotRules", proposed);
      const request = fx.waiting()[0]!.card;
      expect(request.appSettingRequest).toMatchObject({ privateReview: true, after: proposed });
      expect(request.appSettingRequest).not.toHaveProperty("before");
      expect(JSON.stringify(request).includes(earlier)).toBe(false);
      const read = (ownerReview: boolean) => fx.host.review({ threadId: fx.turn.threadId, requestId: String(request.requestId), ownerReview });
      expect(read(true)).toEqual({ status: 200, body: { before: earlier, after: proposed } });
      expect(read(false)).toEqual({ status: 403, body: { error: "Only the owner sees this, from the desktop app or a device paired with full access." } });
      expect(fx.host.review({ threadId: fx.turn.threadId, requestId: "unknown", ownerReview: true })).toBeNull();
      await fx.resolve(String(request.requestId), "deny");
      expect(read(true)).toEqual({ status: 409, body: { error: "This card has closed." } });
    }
  });

  it("reads the old and new value of a setting without a full-text review, and closes the review when the card expires", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(fx.waiting()[0]!.card.requestId);
    expect(fx.host.review({ threadId: fx.turn.threadId, requestId, ownerReview: true })).toEqual({ status: 200, body: { before: "30", after: "45" } });
    fx.clock.at += CONFIRM_MS;
    expect(fx.host.review({ threadId: fx.turn.threadId, requestId, ownerReview: true })?.status).toBe(409);
  });

  it("a card in the owner's own conversation has no private review", async () => {
    const fx = fixture({ verdict: { kind: "confirm", why: "history" } as SettingsVerdict });
    fx.verdict.current = { kind: "clean" } as SettingsVerdict;
    await fx.set("providers.xai.url", "https://example.test/v1");
    expect(fx.waiting()[0]!.card.appSettingRequest).not.toHaveProperty("privateReview");
  });

  it("a setting without a full-text review shows its old value only in the owner's own conversation, on a waiting card and on an applied one", async () => {
    const earlier = "old.address@example.com";
    for (const { name, options, shows } of [
      { name: "own", options: {}, shows: true },
      { name: "history", options: { verdict: CONFIRM_HISTORY }, shows: false },
      { name: "room", options: { group: true, verdict: CONFIRM_HISTORY }, shows: false },
      { name: "room, applied at once", options: { group: true }, shows: false },
    ]) {
      const fx = fixture(options);
      (fx.cfg as { profile?: { email?: string } }).profile = { email: earlier };
      expect((await fx.set("profile.email", "new.address@example.com")).status, name).toBe(200);
      const request = fx.cards().at(-1)!;
      expect(JSON.stringify(request.card).includes(earlier), `${name} applied or waiting`).toBe(shows);
      expect(JSON.stringify(request.card).includes("new.address@example.com"), name).toBe(true);
      if (fx.waiting().length) {
        await fx.resolve(String(request.card.requestId), "allow");
        expect(fx.cards().at(-1)!.card.autoApplied, name).toBe(true);
        expect(JSON.stringify(fx.cards().at(-1)!.card).includes(earlier), `${name} after Apply`).toBe(shows);
        expect(Object.hasOwn(fx.cards().at(-1)!.card.appSettingRequest, "before"), name).toBe(shows);
      }
    }
  });

  it("clearing rules waits, and clearing rules that are already empty changes nothing", async () => {
    const fx = fixture();
    (fx.cfg as { everyBotRules?: string }).everyBotRules = "Be kind";
    (fx.cfg as { profile?: { aboutMe?: string } }).profile = { aboutMe: "I run a shop" };
    for (const id of ["bots.everyBotRules", "profile.aboutMe"]) {
      expect((await fx.set(id, "")).body.text, id).toContain("Nothing has changed yet");
    }
    expect(fx.waiting().map((one) => one.card.appSettingRequest.after)).toEqual(["", ""]);
    expect(fx.waiting()[0]!.card.subtitle).toBe("Be kind\n→\nnot set\nEvery bot will read this from now on.");
    const empty = fixture();
    const result = await empty.set("bots.everyBotRules", "");
    expect(result.body.text).not.toContain("Nothing has changed yet");
    expect(empty.waiting()).toEqual([]);
    expect((empty.cfg as { everyBotRules?: string }).everyBotRules ?? "").toBe("");
  });

  it("new instructions for one bot wait on a card with the old and the new text in full, and clearing them waits too", async () => {
    const fx = fixture();
    (fx.bots[1] as { soul?: string }).soul = `old ${"x".repeat(500)}`;
    const next = `new ${"y".repeat(500)}`;
    await fx.set("bots.settings", { botId: "clive", soul: next });
    const request = fx.waiting()[0]!.card.appSettingRequest;
    expect(request.before).toBe(`old ${"x".repeat(500)}`);
    expect(request.after).toBe(`Clive: instructions "${next}"`);
    await fx.set("bots.settings", { botId: "clive", soul: "" });
    expect(fx.waiting()).toHaveLength(2);
  });

  it("turning the built-in browser off applies at once, and turning it back on waits on a card that says what follows", async () => {
    const fx = fixture();
    expect((await fx.set("bots.settings", { botId: "kiwi", browser: false })).body.text).toContain("Done:");
    expect(fx.waiting()).toEqual([]);
    expect((await fx.set("bots.settings", { botId: "kiwi", browser: true })).body.text).toContain("Nothing has changed yet");
    expect(fx.waiting()[0]!.card.appSettingRequest.consequence).toBe("Kiwi can then use the built-in browser, with the logins saved in it.");
    expect(fx.botPatches).toEqual([{ botId: "kiwi", body: { browser: false } }]);
  });

  it("turning a tool group back on waits and names it, and turning one off applies at once", async () => {
    const fx = fixture();
    (fx.bots[0] as { toolsOff?: string[] }).toolsOff = ["email"];
    expect((await fx.set("bots.tools", { botId: "kiwi", turnOff: ["images"] })).body.text).toContain("Done:");
    expect((await fx.set("bots.tools", { botId: "kiwi", turnOn: ["email"] })).body.text).toContain("Nothing has changed yet");
    expect(fx.waiting()[0]!.card.appSettingRequest.consequence).toBe("Kiwi gets these tools back: Email.");
  });

  it("AC-04 refuses Apply without the owner's review and leaves the setting and the card as they were", async () => {
    const fx = fixture();
    await fx.set("bots.approvalModes", UP);
    const requestId = String(fx.cards()[0]!.card.requestId);
    const refused = await fx.resolve(requestId, "allow", false);
    expect(refused.status).toBe(403);
    expect(fx.botPatches).toEqual([]);
    expect(fx.waiting()).toHaveLength(1);
  });

  it("AC-04 lets Not now through without the owner's review", async () => {
    const fx = fixture();
    await fx.set("bots.approvalModes", UP);
    const answered = await fx.resolve(String(fx.cards()[0]!.card.requestId), "deny", false);
    expect(answered).toEqual({ status: 200, body: { ok: true, outcome: "rejected" } });
    expect(fx.cards()[0]!.card).toMatchObject({ answered: "deny", options: [], appSettingRequest: { result: "declined" } });
    expect(fx.botPatches).toEqual([]);
  });

  it("AC-05 closes a card after fifteen minutes: Apply is refused, the card is expired and nothing changes", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(fx.cards()[0]!.card.requestId);
    fx.clock.at += CONFIRM_MS + 1;
    const late = await fx.resolve(requestId, "allow");
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("This card has closed. Nothing changed.");
    expect(fx.cards()[0]!.card).toMatchObject({ expired: true, options: [], appSettingRequest: { result: "expired" } });
    expect(fx.saved).toEqual([]);
    expect(await fx.resolve(requestId, "allow")).toMatchObject({ status: 200, body: { alreadySettled: true } });
  });

  it("AC-05 expires a card by its own timer after fifteen minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fx = fixture({ verdict: CONFIRM_HISTORY, resumes: true });
      await fx.set("rooms.turnTimeoutMinutes", 45);
      vi.advanceTimersByTime(CONFIRM_MS);
      expect(fx.cards()[0]!.card).toMatchObject({ expired: true, options: [], appSettingRequest: { result: "expired", resumed: true } });
      expect(fx.resumed[0]!.text).toContain("closed before the user applied it");
      expect(fx.saved).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC-05 answers a second tap on a settled card as already settled, without a second change", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(fx.cards()[0]!.card.requestId);
    await fx.resolve(requestId, "allow");
    expect(await fx.resolve(requestId, "allow")).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once", alreadySettled: true } });
    expect(await fx.resolve(requestId, "deny")).toMatchObject({ status: 200, body: { alreadySettled: true } });
    expect(fx.saved).toHaveLength(1);
    const declined = fixture({ verdict: CONFIRM_HISTORY });
    await declined.set("rooms.turnTimeoutMinutes", 45);
    const declinedId = String(declined.cards()[0]!.card.requestId);
    await declined.resolve(declinedId, "deny");
    expect(await declined.resolve(declinedId, "allow")).toEqual({ status: 200, body: { ok: true, outcome: "rejected", alreadySettled: true } });
    expect(declined.saved).toEqual([]);
  });

  it("AC-05 refuses Apply with 409 when the setting changed after the card was shown, and says stale", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY, resumes: true });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    fx.cfg.rooms = { turnTimeoutMinutes: 60 };
    const stale = await fx.resolve(String(fx.cards()[0]!.card.requestId), "allow");
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("This setting changed after the card was shown. Nothing changed.");
    expect(fx.saved).toEqual([]);
    expect(fx.cards()[0]!.card.appSettingRequest).toMatchObject({ result: "stale" });
    expect(fx.resumed[0]!.text).toContain("changed after the card was shown");
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "user-denied", rule: "settings:stale" });
  });

  it("AC-05 returns null for a card that is no settings card", async () => {
    const fx = fixture();
    expect(await fx.host.resolve({ threadId: fx.turn.threadId, requestId: "nothing", behavior: "allow", ownerReview: true })).toBeNull();
  });

  it.each(REFUSALS)("AC-06 refuses a %s turn with 403 and posts no card, for a safe and a risky value", async (_code, options) => {
    const fx = fixture(options as Parameters<typeof fixture>[0]);
    for (const [id, value] of [["rooms.turnTimeoutMinutes", 45], ["bots.approvalModes", UP]] as const) {
      const refused = await fx.set(id, value);
      expect(refused.status, id).toBe(403);
      expect(refused.body.error, id).toMatch(/othing changed|only by hand/i);
    }
    expect([fx.cards(), fx.saved, fx.botPatches]).toEqual([[], [], []]);
  });

  it("AC-06 refuses a guest's turn even when the verdict would wait for a tap", async () => {
    const fx = fixture({ guest: true, verdict: CONFIRM_HISTORY });
    expect((await fx.set("rooms.turnTimeoutMinutes", 45)).status).toBe(403);
    expect(fx.cards()).toEqual([]);
  });

  it.each(REFUSALS)("AC-09 writes a decision log row with rule settings:%s for a refused turn", async (code, options) => {
    const fx = fixture(options as Parameters<typeof fixture>[0]);
    await fx.set("rooms.turnTimeoutMinutes", 45);
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", source: "app-settings", tool: "app_settings", botId: "kiwi", rule: `settings:${code}` });
  });

  it("AC-09 writes a decision log row for every other refusal, with its code", async () => {
    const fx = fixture();
    const last = async () => (await fx.decisions()).at(-1);
    await fx.set("nope.nothing", 1);
    expect(await last()).toMatchObject({ decision: "auto-denied", rule: "settings:unknown" });
    await fx.set("cloud.account", "on");
    expect(await last()).toMatchObject({ decision: "auto-denied", rule: "settings:owner-only" });
    await fx.set("keys.openaiApiKey", OPENAI_KEY);
    expect(await last()).toMatchObject({ decision: "auto-denied", rule: "settings:secret-value" });
    await fx.set("rooms.turnTimeoutMinutes", 100_000);
    expect(await last()).toMatchObject({ decision: "auto-denied", rule: "settings:invalid-value" });
    await fx.set("engines", JSON.stringify({ kind: "remove", instanceId: "openai-compat-gw" }));
    expect(await last()).toMatchObject({ decision: "auto-denied", rule: "settings:not-allowed" });
    for (let index = 0; index < WRITE_BUDGET; index += 1) await fx.set("rooms.turnTimeoutMinutes", 10 + index);
    await fx.set("rooms.turnTimeoutMinutes", 99);
    expect(await last()).toMatchObject({ decision: "auto-denied", rule: "settings:budget" });
    expect(JSON.stringify(await fx.decisions())).not.toContain(OPENAI_KEY);
  });

  it("AC-09 writes a decision log row when a picture file is refused, and when the card limit is reached", async () => {
    const picture = fixture({ pictureRefusal: "a.png is not a PNG, JPEG, GIF or WebP picture." });
    await picture.set("bots.picture", { botId: "kiwi", path: "a.png" });
    expect((await picture.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", rule: "settings:picture" });
    const limit = fixture({ verdict: CONFIRM_HISTORY });
    for (let index = 0; index <= OPEN_CARD_LIMIT; index += 1) await limit.set("rooms.turnTimeoutMinutes", 40 + index);
    expect((await limit.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", rule: "settings:card-limit" });
  });

  it("AC-11 get ai.images lists the models per provider and which providers are ready, and never a key", async () => {
    const fx = fixture();
    const got = await fx.host.handle({ action: "get", id: "ai.images" }, fx.turn);
    const body = JSON.parse(String(got.body.text));
    expect(body.models.openai).toContain("gpt-image-2");
    expect(body.models).not.toHaveProperty("custom");
    expect(body.ready).toEqual({ openai: true, codex: false, xai: false, gemini: false, openrouter: false, custom: false });
    expect(body.readyHelp).toContain("keys.* opens a secure card");
    expect(JSON.stringify(got)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(got)).not.toContain(GATEWAY_KEY);
    expect(Object.keys(body).filter((field) => /key|token|secret|password/i.test(field))).toEqual([]);
  });

  it("AC-12 refuses an image model that the provider does not offer and lists the models that it does", async () => {
    const fx = fixture();
    const refused = await fx.set("ai.images", { primary: { provider: "openai", model: "gpt-banana" } });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toContain("gpt-banana is not a openai image model. Use one of: gpt-image-2.6-sunburst (GPT Image 2.6 Sunburst)");
    expect((await fx.set("ai.images", { fallback: { provider: "xai", model: "nope" } })).status).toBe(409);
    expect((await fx.set("ai.images", { primary: { provider: "openrouter", model: "gpt-banana" } })).status).toBe(409);
    expect([fx.cards(), fx.saved]).toEqual([[], []]);
  });

  it("AC-12 accepts an OpenRouter vendor/model id, a listed model and any model of a custom endpoint", async () => {
    const fx = fixture();
    const routed = await fx.setAndApply("ai.images", { primary: { provider: "openrouter", model: "anthropic/claude-image-x" } });
    expect(routed.applied.status).toBe(200);
    expect(fx.saved).toEqual([{ imageGen: { primary: { provider: "openrouter", model: "anthropic/claude-image-x" } } }]);
    expect((await fx.set("ai.images", { primary: { provider: "openai", model: "gpt-image-1" } })).status).toBe(200);
    expect((await fx.set("ai.images", { fallback: { provider: "custom", model: "any-model" } })).status).toBe(200);
  });

  it("AC-14 undoes a change after the server restarts, from a file only the owner reads", async () => {
    const fx = fixture();
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(fx.cards()[0]!.card.requestId);
    expect(statSync(join(fx.dataDir, "app-settings-undo.json")).mode & 0o777).toBe(0o600);
    const reopened = fx.build();
    expect(await reopened.undo({ threadId: fx.turn.threadId, requestId })).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
  });

  it("AC-14 undoes a change that the owner applied from a card after the server restarts", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    const { requestId } = await fx.setAndApply("rooms.turnTimeoutMinutes", 45);
    const reopened = fx.build();
    expect(await reopened.undo({ threadId: fx.turn.threadId, requestId })).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
  });

  it("AC-14 refuses Undo after a restart when the setting changed since", async () => {
    const fx = fixture();
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const requestId = String(fx.cards()[0]!.card.requestId);
    fx.cfg.rooms = { turnTimeoutMinutes: 60 };
    expect(await fx.build().undo({ threadId: fx.turn.threadId, requestId })).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
  });

  it(`AC-18 refuses the ${OPEN_CARD_LIMIT + 1}th waiting card in a thread with 429`, async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    for (let index = 0; index < OPEN_CARD_LIMIT; index += 1) expect((await fx.set("rooms.turnTimeoutMinutes", 41 + index)).status).toBe(200);
    const over = await fx.set("rooms.turnTimeoutMinutes", 50);
    expect(over.status).toBe(429);
    expect(String(over.body.error)).toContain(`${OPEN_CARD_LIMIT} settings cards already wait`);
    expect(fx.waiting()).toHaveLength(OPEN_CARD_LIMIT);
  });

  it("AC-18 does not count a card that Stop closed", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    for (let index = 0; index < OPEN_CARD_LIMIT; index += 1) await fx.set("rooms.turnTimeoutMinutes", 41 + index);
    expect((await fx.set("rooms.turnTimeoutMinutes", 50)).status).toBe(429);
    const row = fx.waiting()[0]!;
    const closed = closedByStop(row.card as never);
    expect(closed).toMatchObject({ answered: "unavailable", dismissed: true });
    row.card = closed;
    expect((await fx.set("rooms.turnTimeoutMinutes", 50)).status).toBe(200);
    expect(fx.waiting()).toHaveLength(OPEN_CARD_LIMIT);
  });

  it("AC-18 counts cards per thread and frees the place of an answered card", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    for (let index = 0; index < OPEN_CARD_LIMIT; index += 1) await fx.set("rooms.turnTimeoutMinutes", 41 + index);
    await fx.resolve(String(fx.waiting()[0]!.card.requestId), "deny");
    expect((await fx.set("rooms.turnTimeoutMinutes", 50)).status).toBe(200);
  });

  it("AC-19 logs Apply as user-approved and gives the bot the applied text, marking the card resumed", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY, resumes: true });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const row = fx.cards()[0]!;
    await fx.resolve(String(row.card.requestId), "allow");
    expect(fx.resumed).toEqual([{ threadId: "t-kiwi", messageId: row.id, text: appSettingDecisionText(row.card) }]);
    expect(fx.resumed[0]!.text).toBe("The user applied the change: Room turn timeout is now 45. They can undo it from the card.");
    expect(row.card.appSettingRequest.resumed).toBe(true);
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "user-approved", source: "app-settings", requestId: row.card.requestId, summary: "rooms.turnTimeoutMinutes: 30 → 45" });
  });

  it("AC-19 logs Not now as user-denied and gives the bot the declined text", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY, resumes: true });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const row = fx.cards()[0]!;
    await fx.resolve(String(row.card.requestId), "deny");
    expect(fx.resumed).toEqual([{ threadId: "t-kiwi", messageId: row.id, text: appSettingDecisionText(row.card) }]);
    expect(fx.resumed[0]!.text).toBe("The user declined the change to Room turn timeout. Nothing changed.");
    expect(row.card.appSettingRequest.resumed).toBe(true);
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "user-denied", source: "app-settings", requestId: row.card.requestId });
  });

  it("AC-19 leaves the card not resumed when no turn waits on it yet", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY, resumes: false });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    await fx.resolve(String(fx.cards()[0]!.card.requestId), "allow");
    expect(fx.resumed).toHaveLength(1);
    expect(fx.cards()[0]!.card.appSettingRequest).not.toHaveProperty("resumed");
    expect(fx.cards()[0]!.card.appSettingRequest.result).toBe("applied");
  });

  it("AC-19 words each end of a card for the bot", () => {
    const request = { settingId: "x", label: "Room turn timeout", after: "45", tier: "safe" as const };
    expect(appSettingDecisionText({ appSettingRequest: request })).toBe("The settings card is still waiting for the user.");
    expect(appSettingDecisionText({ appSettingRequest: { ...request, result: "expired" } })).toContain("closed before the user applied it");
    expect(appSettingDecisionText({ appSettingRequest: { ...request, result: "stale" } })).toContain("changed after the card was shown");
    expect(appSettingDecisionText({ appSettingRequest: { ...request, result: "failed" } })).toBe("Applying the change to Room turn timeout failed. Nothing changed.");
  });
});

describe("review gaps in settings confirm cards", () => {
  const DECIDER_KEY = "decider-key-7f3a91";
  const DECIDER_TOKEN = "workers-token-52bc10";
  const IMAGE_KEY = "image-key-c04d68";
  const GEMINI_KEY = "gemini-key-e9a217";
  const SECRETS = [DECIDER_KEY, DECIDER_TOKEN, IMAGE_KEY, GEMINI_KEY];
  const withKeys = (fx: ReturnType<typeof fixture>) => {
    Object.assign(fx.cfg, {
      decider: { provider: "jev", key: DECIDER_KEY, workersAiToken: DECIDER_TOKEN },
      imageGen: { primary: { provider: "openai" }, key: IMAGE_KEY, geminiKey: GEMINI_KEY },
    });
  };
  const hasKeyField = (value: unknown): boolean => /"[^"]*(key|token|secret|password)[^"]*":/i.test(JSON.stringify(value));
  const restarted = (fx: ReturnType<typeof fixture>) => fx.build();

  it.each(["baseUrl", "openrouterBaseUrl", "workersAiBaseUrl"])("AC-07 refuses %s on ai.routing as an invalid value and leaves the config as it was", async (field) => {
    const fx = fixture();
    withKeys(fx);
    const before = JSON.stringify(fx.cfg.decider);
    const refused = await fx.set("ai.routing", { enabled: true, [field]: "https://collector.example/v1" });
    expect(refused.status).toBe(400);
    expect(fx.saved).toEqual([]);
    expect(fx.cards()).toEqual([]);
    expect(JSON.stringify(fx.cfg.decider)).toBe(before);
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", rule: "settings:invalid-value" });
  });

  it("AC-07 keeps every key out of the undo file after a bot changes ai.routing or ai.images", async () => {
    const fx = fixture();
    withKeys(fx);
    expect((await fx.set("ai.routing", { enabled: true })).status).toBe(200);
    expect((await fx.set("ai.images", { maxPerTurn: 3 })).status).toBe(200);
    const file = readFileSync(join(fx.dataDir, "app-settings-undo.json"), "utf8");
    for (const secret of SECRETS) expect(file).not.toContain(secret);
    expect(file).toContain("ai.routing");
    expect(file).toContain("ai.images");
  });

  it("AC-07 writes back only fields that are no key when Undo restores ai.routing and ai.images", async () => {
    const fx = fixture();
    withKeys(fx);
    await fx.set("ai.routing", { enabled: true });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toEqual({ decider: { provider: "jev" } });
    await fx.set("ai.images", { maxPerTurn: 3 });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.saved.at(-1)).toEqual({ imageGen: { primary: { provider: "openai" } } });
    expect(hasKeyField(fx.saved)).toBe(false);
    for (const secret of SECRETS) expect(JSON.stringify(fx.saved)).not.toContain(secret);
  });

  it("AC-07 shows a section on get without any key", async () => {
    const fx = fixture();
    withKeys(fx);
    const got = JSON.stringify(await fx.host.handle({ action: "get", id: "ai.routing" }, fx.turn));
    for (const secret of SECRETS) expect(got).not.toContain(secret);
  });

  it("AC-05 refuses Apply when the bot's field changed although the setting's text did not", async () => {
    const fx = fixture({ resumes: true });
    expect((await fx.set("bots.settings", { botId: "clive", soul: "Be brief" })).body.text).toContain("Nothing has changed yet");
    const card = fx.waiting()[0]!.card;
    (fx.bots[1] as { soul?: string }).soul = "Changed in the bot's own panel";
    const stale = await fx.resolve(String(card.requestId), "allow");
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("This setting changed after the card was shown. Nothing changed.");
    expect(fx.botPatches).toEqual([]);
    expect(fx.cards()[0]!.card.appSettingRequest).toMatchObject({ result: "stale" });
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "user-denied", rule: "settings:stale", requestId: card.requestId });
  });

  it("AC-05 still applies a bots.settings card when the bot's field did not change", async () => {
    const fx = fixture();
    const { applied } = await fx.setAndApply("bots.settings", { botId: "clive", soul: "Be brief" });
    expect(applied.status).toBe(200);
    expect(fx.botPatches).toEqual([{ botId: "clive", body: { soul: "Be brief" } }]);
  });

  it("AC-05 refuses Undo of a bots.settings change when the bot's field changed after the apply", async () => {
    const fx = fixture();
    expect((await fx.set("bots.settings", { botId: "clive", notifications: false })).status).toBe(200);
    (fx.bots[1] as { notifications?: boolean }).notifications = true;
    expect(await fx.undo()).toMatchObject({ claimed: true, state: "invalid", error: UNDO_STALE, stale: true });
    expect(fx.botPatches).toEqual([{ botId: "clive", body: { notifications: false } }]);
  });

  it("AC-05 undoes a bots.settings change while the bot's field is still the applied one", async () => {
    const fx = fixture();
    await fx.set("bots.settings", { botId: "clive", notifications: false });
    expect(await fx.undo()).toEqual({ claimed: true, state: "undone" });
    expect(fx.botPatches.at(-1)).toEqual({ botId: "clive", body: { notifications: true } });
  });

  it("AC-05 closes a card left from before a restart as expired when the owner taps Apply, and resumes the turn", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY, resumes: true });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const row = fx.cards()[0]!;
    const requestId = String(row.card.requestId);
    const late = await restarted(fx).resolve({ threadId: fx.turn.threadId, requestId, behavior: "allow", ownerReview: true });
    expect(late).toMatchObject({ status: 409, body: { error: "This card has closed. Nothing changed." } });
    expect(row.card).toMatchObject({ expired: true, options: [], appSettingRequest: { result: "expired" } });
    expect(fx.saved).toEqual([]);
    expect(fx.resumed).toHaveLength(1);
    expect(fx.resumed[0]).toMatchObject({ threadId: fx.turn.threadId, messageId: row.id });
    expect(fx.resumed[0]!.text).toContain("closed before the user applied it");
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", source: "app-settings", rule: "settings:expired", requestId });
  });

  it("AC-19 expireOrphan closes a card from before a restart as expired and does not resume the turn", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY, resumes: true });
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const row = fx.cards()[0]!;
    const closed = restarted(fx).expireOrphan(fx.turn.threadId, row.id);
    expect(closed).toMatchObject({ expired: true, options: [], appSettingRequest: { result: "expired" } });
    expect(row.card).toMatchObject({ expired: true, appSettingRequest: { result: "expired" } });
    expect(fx.resumed).toEqual([]);
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", rule: "settings:expired", requestId: row.card.requestId });
  });

  it("AC-19 expireOrphan returns null for a card that is applied, still held, already closed, or no settings card", async () => {
    const fx = fixture({ verdict: CONFIRM_HISTORY });
    const after = restarted(fx);
    await fx.set("rooms.turnTimeoutMinutes", 45);
    const held = fx.cards()[0]!;
    expect(fx.host.expireOrphan(fx.turn.threadId, held.id)).toBeNull();
    expect(held.card.expired).toBeUndefined();
    const { requestId } = await fx.setAndApply("rooms.turnTimeoutMinutes", 50);
    const appliedRow = fx.cards().find((row) => row.card.requestId === requestId)!;
    expect(after.expireOrphan(fx.turn.threadId, appliedRow.id)).toBeNull();
    expect(fx.host.expireOrphan(fx.turn.threadId, appliedRow.id)).toBeNull();
    fx.messages.push({ id: "m-plain", threadId: fx.turn.threadId, role: "bot", kind: "options", card: { title: "Pick one", options: ["A", "B"], requestId: "plain" } });
    expect(after.expireOrphan(fx.turn.threadId, "m-plain")).toBeNull();
    expect(after.expireOrphan(fx.turn.threadId, "no-such-message")).toBeNull();
    expect(after.expireOrphan(fx.turn.threadId, held.id)).toMatchObject({ expired: true });
    expect(after.expireOrphan(fx.turn.threadId, held.id)).toBeNull();
  });

  it("AC-19 reports a failed Apply to the bot with the route's refusal, and to the owner with fixed words only", async () => {
    const fx = fixture({ patchRefusal: "the route said no: /api/bots/clive", resumes: true });
    await fx.set("bots.approvalModes", UP);
    const row = fx.cards()[0]!;
    const failed = await fx.resolve(String(row.card.requestId), "allow");
    expect(failed.status).toBe(409);
    expect(failed.body.error).toBe("The change could not be applied. Nothing changed.");
    expect(row.card).not.toHaveProperty("held");
    expect(row.card.appSettingRequest).toMatchObject({ result: "failed" });
    expect(JSON.stringify(row.card)).not.toContain("the route said no");
    expect(fx.resumed).toHaveLength(1);
    expect(fx.resumed[0]!.text).toContain("the route said no: /api/bots/clive");
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "user-denied", rule: "settings:failed" });
  });

  it("AC-09 logs a direct set whose write fails as auto-denied with rule settings:failed", async () => {
    const fx = fixture({ patchRefusal: "the route said no" });
    const refused = await fx.set("bots.name", { botId: "clive", name: "Clover" });
    expect(refused).toMatchObject({ status: 409, body: { error: "the route said no" } });
    expect(fx.cards()).toEqual([]);
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", source: "app-settings", rule: "settings:failed", botId: "kiwi" });
  });

  it("AC-09 logs a card that expires by its timer as auto-denied with rule settings:expired", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let fx!: ReturnType<typeof fixture>;
    try {
      fx = fixture({ verdict: CONFIRM_HISTORY });
      await fx.set("rooms.turnTimeoutMinutes", 45);
      vi.advanceTimersByTime(CONFIRM_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(fx.cards()[0]!.card).toMatchObject({ expired: true, appSettingRequest: { result: "expired" } });
    expect((await fx.decisions()).at(-1)).toMatchObject({ decision: "auto-denied", source: "app-settings", rule: "settings:expired", requestId: fx.cards()[0]!.card.requestId });
  });
});
