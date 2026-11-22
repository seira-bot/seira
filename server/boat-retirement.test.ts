import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSurface } from "./surface.ts";
import { retireBoatFromBots, retireBoatFromBotsAtBoot, retireBoatFromFiles } from "./boat-retirement.ts";

let dir: string;
const logs: string[] = [];
const log = (line: string) => { logs.push(line); };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "boat-retire-")); logs.length = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const bytes = (name: string) => readFileSync(join(dir, name), "utf8");

describe("bots and thread pins", () => {
  it("moves a Cloud bot on Boat, or with no backend, to its VPS when it has one", () => {
    const bots = [
      { id: "a", computer: "cloud", cloudBackend: "box", vpsAlias: "my-vps" },
      { id: "b", computer: "cloud" },
      { id: "c", computer: "cloud", cloudBackend: "vps", vpsAlias: "my-vps" },
    ];
    expect(retireBoatFromBots(bots, null)).toEqual({ bots: 2, pins: 0 });
    expect(bots).toEqual([
      { id: "a", computer: "cloud", cloudBackend: "vps", vpsAlias: "my-vps" },
      { id: "b", computer: "off" },
      { id: "c", computer: "cloud", cloudBackend: "vps", vpsAlias: "my-vps" },
    ]);
  });

  it("uses the install's default VPS for a bot that has none of its own", () => {
    const bots = [{ id: "a", computer: "cloud", cloudBackend: "box" }];
    retireBoatFromBots(bots, "default-vps");
    expect(bots[0]).toEqual({ id: "a", computer: "cloud", cloudBackend: "vps" });
  });

  it("gives a Cloud bot with no VPS no computer, never this computer or a virtual machine", () => {
    const bots = [{ id: "a", computer: "cloud", cloudBackend: "box" }, { id: "b", computer: "cloud" }];
    retireBoatFromBots(bots, null);
    expect(bots.map((bot) => bot.computer)).toEqual(["off", "off"]);
    expect(bots.every((bot) => !("cloudBackend" in bot))).toBe(true);
  });

  it("leaves the choice of a bot that never used Cloud, and forgets a Boat backend it only remembered", () => {
    const bots = [
      { id: "a", computer: "local" }, { id: "b" }, { id: "c", computer: "vm", cloudBackend: "box" }, { id: "d", cloudBackend: "box" },
    ];
    expect(retireBoatFromBots(bots, null)).toEqual({ bots: 2, pins: 0 });
    expect(bots).toEqual([{ id: "a", computer: "local" }, { id: "b" }, { id: "c", computer: "vm" }, { id: "d" }]);
    const withVps = [{ id: "c", computer: "vm", cloudBackend: "box" }];
    retireBoatFromBots(withVps, "default-vps");
    expect(withVps[0]).toEqual({ id: "c", computer: "vm", cloudBackend: "vps" });
  });

  it("leaves a bot that depends on the default VPS alone while the settings file cannot be read, then moves it once it can", () => {
    const bots = [
      { id: "own", computer: "cloud", cloudBackend: "box", vpsAlias: "my-vps" },
      { id: "dflt", computer: "cloud", cloudBackend: "box", tasks: [{ threadId: "t", surface: "cloud", surfaceSource: "auto" }] },
    ];
    expect(retireBoatFromBots(bots, undefined)).toEqual({ bots: 1, pins: 0 });
    expect(bots[1]).toEqual({ id: "dflt", computer: "cloud", cloudBackend: "box", tasks: [{ threadId: "t", surface: "cloud", surfaceSource: "auto" }] });
    retireBoatFromBots(bots, "default-vps");
    expect(bots[1]).toMatchObject({ computer: "cloud", cloudBackend: "vps" });
  });

  it("reads a settings file that is broken as unknown, and a missing one as no VPS", () => {
    const bots = () => [{ id: "a", computer: "cloud", cloudBackend: "box" }];
    writeFileSync(join(dir, "config.json"), "{ broken");
    const broken = bots();
    expect(retireBoatFromBotsAtBoot(dir, broken, log)).toBe(false);
    expect(broken[0].computer).toBe("cloud");
    rmSync(join(dir, "config.json"));
    const missing = bots();
    expect(retireBoatFromBotsAtBoot(dir, missing, log)).toBe(true);
    expect(missing[0].computer).toBe("off");
  });

  it("clears the cloud pin a turn made on its own where there is no VPS, and keeps the ones a person chose", () => {
    const bots = [{
      id: "a", computer: "cloud", cloudBackend: "box",
      tasks: [
        { threadId: "auto", surface: "cloud", surfaceSource: "auto" },
        { threadId: "chosen", surface: "cloud", surfaceSource: "user" },
        { threadId: "local", surface: "local", surfaceSource: "auto" },
      ],
    }];
    expect(retireBoatFromBots(bots, null)).toEqual({ bots: 1, pins: 1 });
    expect(bots[0]!.tasks).toEqual([
      { threadId: "auto" },
      { threadId: "chosen", surface: "cloud", surfaceSource: "user" },
      { threadId: "local", surface: "local", surfaceSource: "auto" },
    ]);
  });

  it("keeps every pin where the bot has a VPS, since Cloud now means that VPS", () => {
    const bots = [{ id: "a", computer: "cloud", cloudBackend: "box", vpsAlias: "my-vps", tasks: [{ threadId: "t", surface: "cloud", surfaceSource: "auto" }] }];
    expect(retireBoatFromBots(bots, null)).toEqual({ bots: 1, pins: 0 });
    expect(bots[0]!.tasks).toEqual([{ threadId: "t", surface: "cloud", surfaceSource: "auto" }]);
  });

  it("never raises a bot that is Off to Cloud: its saved pin is ignored, and a Cloud pin on a Boat backend is cleaned like any other", () => {
    const pins = () => [
      { threadId: "auto", surface: "cloud", surfaceSource: "auto" },
      { threadId: "chosen", surface: "cloud", surfaceSource: "user" },
      { threadId: "vm", surface: "vm", surfaceSource: "user" },
    ];
    // No VPS: the bot stays Off and loses only the Boat backend; the automatic pin goes, the chosen ones stay but are never used.
    const bare = [{ id: "a", computer: "off", cloudBackend: "box", tasks: pins() }];
    expect(retireBoatFromBots(bare, null)).toEqual({ bots: 1, pins: 1 });
    expect(bare[0]).toEqual({ id: "a", computer: "off", tasks: [{ threadId: "auto" }, pins()[1], pins()[2]] });
    // A VPS exists: the backend moves to it, the bot is still Off and the pins are left as they are.
    const withVps = [{ id: "b", computer: "off", cloudBackend: "box", vpsAlias: "my-vps", tasks: pins() }];
    expect(retireBoatFromBots(withVps, null)).toEqual({ bots: 1, pins: 0 });
    expect(withVps[0]).toMatchObject({ computer: "off", cloudBackend: "vps", tasks: pins() });
    // Whatever pin is left, an Off bot gets no computer and no browser.
    for (const bot of [bare[0]!, withVps[0]!]) {
      for (const task of bot.tasks as Array<{ surface?: "cloud" | "vm" }>) {
        expect(resolveSurface({ destination: "off", pinnedSurface: task.surface, browserOn: true })).toMatchObject({ computer: "off", browser: false, pinned: null });
      }
    }
    // The second run changes nothing.
    const once = structuredClone([...bare, ...withVps]);
    expect(retireBoatFromBots([...bare, ...withVps], null)).toEqual({ bots: 0, pins: 0 });
    expect([...bare, ...withVps]).toEqual(once);
  });

  it("changes nothing the second time", () => {
    const bots = [
      { id: "a", computer: "cloud", cloudBackend: "box", tasks: [{ threadId: "t", surface: "cloud", surfaceSource: "auto" }] },
      { id: "b", computer: "cloud", cloudBackend: "box", vpsAlias: "my-vps" },
    ];
    retireBoatFromBots(bots, null);
    const once = structuredClone(bots);
    expect(retireBoatFromBots(bots, null)).toEqual({ bots: 0, pins: 0 });
    expect(bots).toEqual(once);
  });

  it("reads the default VPS from config.json at start, saves only when something moved, and logs counts", () => {
    write("config.json", { vps: { sshAlias: "default-vps" } });
    const bots = [{ id: "secret-bot-id", computer: "cloud", cloudBackend: "box" }];
    expect(retireBoatFromBotsAtBoot(dir, bots, log)).toBe(true);
    expect(bots[0]).toEqual({ id: "secret-bot-id", computer: "cloud", cloudBackend: "vps" });
    expect(logs).toEqual(["[boat] moved 1 bots off Boat and cleared 0 automatic cloud pins"]);
    logs.length = 0;
    expect(retireBoatFromBotsAtBoot(dir, bots, log)).toBe(false);
    expect(logs).toEqual([]);
  });

  it("never throws, and logs no bot data when it fails", () => {
    expect(retireBoatFromBotsAtBoot(dir, [{ get tasks(): never { throw new Error("boom with a-secret"); }, computer: "cloud", cloudBackend: "vps" } as never], log)).toBe(false);
    expect(logs.at(-1)).toBe("[boat] could not move the bots off Boat; they are left as they are");
    expect(logs.join("\n")).not.toContain("a-secret");
  });

  it("leaves an install with no Boat records as it is", () => {
    const bots = [{ id: "a", computer: "cloud", cloudBackend: "vps", vpsAlias: "my-vps" }, { id: "b" }, { id: "c", computer: "local" }];
    const before = structuredClone(bots);
    expect(retireBoatFromBots(bots, "default-vps")).toEqual({ bots: 0, pins: 0 });
    expect(bots).toEqual(before);
  });
});

describe("config.json: the Boat key and new-bot defaults", () => {
  it("deletes the Boat key, keeps a dated copy and every other setting", () => {
    write("config.json", { box: { token: "boat-key-123" }, language: "en", vps: { sshAlias: "my-vps" }, anthropic: { key: "k" } });
    const counts = retireBoatFromFiles(dir, log);
    expect(counts.key).toBe(1);
    expect(read("config.json")).toEqual({ language: "en", vps: { sshAlias: "my-vps" }, anthropic: { key: "k" } });
    const copies = readdirSync(dir).filter((name) => name.startsWith("config.json.bak."));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]!), "utf8")).toContain("boat-key-123");
    expect(logs.join("\n")).not.toContain("boat-key-123");
  });

  it("moves new-bot defaults like a bot: to the default VPS when set, otherwise no computer", () => {
    write("config.json", { vps: { sshAlias: "my-vps" }, newBotDefaults: { profile: { computer: "cloud", cloudBackend: "box" } } });
    expect(retireBoatFromFiles(dir, log).defaults).toBe(1);
    expect(read("config.json").newBotDefaults.profile).toEqual({ computer: "cloud", cloudBackend: "vps" });
    write("config.json", { newBotDefaults: { profile: { computer: "cloud" } } });
    expect(retireBoatFromFiles(dir, log).defaults).toBe(1);
    expect(read("config.json").newBotDefaults.profile).toEqual({ computer: "off" });
    write("config.json", { newBotDefaults: { profile: { computer: "local", cloudBackend: "box" } } });
    retireBoatFromFiles(dir, log);
    expect(read("config.json").newBotDefaults.profile).toEqual({ computer: "local" });
  });

  it("changes nothing the second time and writes no second copy", () => {
    write("config.json", { box: { token: "x" }, newBotDefaults: { profile: { computer: "cloud", cloudBackend: "box" } } });
    retireBoatFromFiles(dir, log);
    const after = bytes("config.json"), copies = readdirSync(dir).length;
    logs.length = 0;
    const again = retireBoatFromFiles(dir, log);
    expect(Object.values(again).every((count) => count === 0)).toBe(true);
    expect(bytes("config.json")).toBe(after);
    expect(readdirSync(dir)).toHaveLength(copies);
    expect(logs).toEqual([]);
  });

  it("leaves a config.json that is not valid JSON exactly as it is", () => {
    writeFileSync(join(dir, "config.json"), "{ \"box\": ");
    expect(() => retireBoatFromFiles(dir, log)).not.toThrow();
    expect(bytes("config.json")).toBe("{ \"box\": ");
  });
});

describe("routines, webhooks and app automations", () => {
  it("moves a routine that ran on Boat off Cloud and pauses it, with the runs still to happen cancelled", () => {
    write("bots.json", [{ id: "away", computer: "cloud" }]);
    write("routines.json", {
      version: 1,
      routines: [{ id: "r1", botId: "away", runOn: "cloud", name: "Digest" }, { id: "r2", botId: "away", runOn: "seira", name: "Local" }],
      runs: [
        { id: "q", botId: "away", runOn: "cloud", status: "queued" }, { id: "w", botId: "away", runOn: "cloud", status: "waiting" },
        { id: "d", botId: "away", runOn: "cloud", status: "done" }, { id: "s", botId: "away", runOn: "seira", status: "queued" },
      ],
      holds: [],
    });
    const counts = retireBoatFromFiles(dir, log);
    expect([counts.routines, counts.runs]).toEqual([1, 2]);
    const disk = read("routines.json");
    expect(disk.routines.map((routine: { runOn: string }) => routine.runOn)).toEqual(["seira", "seira"]);
    expect(disk.runs.map((run: { runOn: string }) => run.runOn)).toEqual(["seira", "seira", "cloud", "seira"]);
    expect(disk.holds).toEqual([]);
  });

  it("moves webhooks and app automations, deleted ones that can still be restored included", () => {
    write("bots.json", [{ id: "away", computer: "cloud" }]);
    write("webhooks.json", { version: 1, webhooks: [{ id: "w", botId: "away", runOn: "cloud" }, { id: "x", botId: "away", runOn: "seira" }], deliveries: [], deleted: [{ at: 1, webhook: { id: "gone", botId: "away", runOn: "cloud" } }] });
    write("app-triggers.json", { version: 1, pollerId: "poller-12345", cursor: 0, triggers: [{ id: "t", botId: "away", runOn: "cloud" }], attempts: [], deleted: [] });
    const counts = retireBoatFromFiles(dir, log);
    expect([counts.webhooks, counts.appTriggers]).toEqual([2, 1]);
    expect(read("webhooks.json").webhooks.map((hook: { runOn: string }) => hook.runOn)).toEqual(["seira", "seira"]);
    expect(read("webhooks.json").deleted[0].webhook.runOn).toBe("seira");
    expect(read("app-triggers.json").triggers[0].runOn).toBe("seira");
  });

  it("switches off every old Cloud automation, whatever its bot or conversation is set to, and cancels what waits", () => {
    // Cloud, Auto, this computer, a virtual machine, no computer: and a Cloud bot whose reused conversation is pinned to this computer.
    write("bots.json", [
      { id: "here", computer: "local" }, { id: "vm", computer: "vm" }, { id: "away", computer: "cloud", tasks: [{ threadId: "pinned", surface: "local", surfaceSource: "user" }] },
      { id: "plain" }, { id: "none", computer: "off" },
    ]);
    const routine = (id: string, botId: string) => ({ id, botId, runOn: "cloud", enabled: true, nextRunAt: 5 });
    write("routines.json", {
      routines: [routine("r1", "here"), routine("r2", "vm"), { ...routine("r3", "away"), sameConversation: true, threadId: "pinned" }, routine("r4", "plain"), routine("r5", "none")],
      runs: ["here", "away", "plain"].map((botId, index) => ({ id: `run${index}`, botId, runOn: "cloud", status: "queued" })),
    });
    write("webhooks.json", { version: 1, webhooks: [{ id: "w1", botId: "vm", runOn: "cloud", enabled: true }, { id: "w2", botId: "away", runOn: "cloud", enabled: true }, { id: "w3", botId: "plain", runOn: "cloud", enabled: true }], deliveries: [] });
    write("app-triggers.json", { version: 1, pollerId: "poller-12345", cursor: 0, triggers: [{ id: "t1", botId: "here", runOn: "cloud", enabled: true }, { id: "t2", botId: "away", runOn: "cloud", enabled: true }], attempts: [], deleted: [] });
    retireBoatFromFiles(dir, log);
    const routines = read("routines.json");
    expect(routines.routines.map((row: { enabled: boolean; nextRunAt: number | null; runOn: string }) => [row.enabled, row.nextRunAt, row.runOn])).toEqual(Array(5).fill([false, null, "seira"]));
    expect(routines.runs.map((run: { status: string }) => run.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(routines.runs[0].error).toMatch(/Choose where the bot works/);
    expect(read("webhooks.json").webhooks.map((hook: { enabled: boolean }) => hook.enabled)).toEqual([false, false, false]);
    expect(read("app-triggers.json").triggers.map((trigger: { enabled: boolean }) => trigger.enabled)).toEqual([false, false]);
    // Each one is marked, so Run now and Test refuse until the person picks a place again.
    expect(routines.routines.map((row: { placeLost?: boolean }) => row.placeLost)).toEqual(Array(5).fill(true));
    expect(read("webhooks.json").webhooks.map((hook: { placeLost?: boolean }) => hook.placeLost)).toEqual([true, true, true]);
    expect(read("app-triggers.json").triggers.map((trigger: { placeLost?: boolean }) => trigger.placeLost)).toEqual([true, true]);
    const again = [bytes("routines.json"), bytes("webhooks.json"), bytes("app-triggers.json")];
    retireBoatFromFiles(dir, log);
    expect([bytes("routines.json"), bytes("webhooks.json"), bytes("app-triggers.json")]).toEqual(again);
  });

  it("marks only what used Cloud: an automation that was already paused on this computer stays as it is", () => {
    write("routines.json", { routines: [{ id: "old", runOn: "seira", enabled: false, nextRunAt: null }, { id: "cloud", runOn: "cloud", enabled: true, nextRunAt: 9 }], runs: [] });
    retireBoatFromFiles(dir, log);
    const [paused, moved] = read("routines.json").routines;
    expect(paused).toEqual({ id: "old", runOn: "seira", enabled: false, nextRunAt: null });
    expect(moved).toMatchObject({ runOn: "seira", enabled: false, placeLost: true });
  });

  it("does not need the list of bots, and leaves a broken one alone", () => {
    writeFileSync(join(dir, "bots.json"), "{ not json");
    write("routines.json", { routines: [{ id: "r", botId: "a", runOn: "cloud", enabled: true }], runs: [] });
    retireBoatFromFiles(dir, log);
    expect(read("routines.json").routines[0]).toMatchObject({ runOn: "seira", enabled: false });
    expect(bytes("bots.json")).toBe("{ not json");
  });

  it("changes nothing the second time, and leaves a file it cannot read as it is while the others still move", () => {
    write("routines.json", { routines: [{ id: "r", runOn: "cloud" }], runs: [] });
    writeFileSync(join(dir, "webhooks.json"), "not json at all");
    write("app-triggers.json", { version: 1, pollerId: "poller-12345", cursor: 0, triggers: [{ id: "t", runOn: "cloud" }] });
    retireBoatFromFiles(dir, log);
    expect(bytes("webhooks.json")).toBe("not json at all");
    expect(read("app-triggers.json").triggers[0].runOn).toBe("seira");
    expect(logs.join("\n")).toContain("could not be updated");
    const routines = bytes("routines.json"), triggers = bytes("app-triggers.json");
    expect(Object.values(retireBoatFromFiles(dir, log)).every((count) => count === 0)).toBe(true);
    expect(bytes("routines.json")).toBe(routines);
    expect(bytes("app-triggers.json")).toBe(triggers);
  });

  it("logs counts only", () => {
    write("config.json", { box: { token: "boat-key-123" } });
    write("routines.json", { routines: [{ id: "private-routine", name: "Quarterly payroll", prompt: "secret", runOn: "cloud" }], runs: [] });
    retireBoatFromFiles(dir, log);
    expect(logs).toEqual(["[boat] removed 1 Boat keys, moved 0 new-bot defaults, 1 routines, 0 pending runs, 0 webhooks and 0 app automations off Boat"]);
  });

  it("does nothing, and writes no file, in a data folder that has no Boat records", () => {
    expect(retireBoatFromFiles(dir, log)).toEqual({ bots: 0, pins: 0, defaults: 0, routines: 0, runs: 0, webhooks: 0, appTriggers: 0, key: 0 });
    expect(readdirSync(dir)).toEqual([]);
    write("routines.json", { routines: [{ id: "r", runOn: "seira" }], runs: [] });
    const before = bytes("routines.json");
    retireBoatFromFiles(dir, log);
    expect(bytes("routines.json")).toBe(before);
    expect(logs).toEqual([]);
  });
});
