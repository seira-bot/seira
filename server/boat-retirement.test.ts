import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("treats a config.json it cannot read as no VPS, and never throws", () => {
    writeFileSync(join(dir, "config.json"), "{ not json");
    const bots = [{ id: "a", computer: "cloud", cloudBackend: "box" }];
    expect(retireBoatFromBotsAtBoot(dir, bots, log)).toBe(true);
    expect(bots[0]).toEqual({ id: "a", computer: "off" });
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
  it("moves a routine that ran on Boat to this server's provider, with the runs still to happen", () => {
    write("routines.json", {
      version: 1,
      routines: [{ id: "r1", runOn: "cloud", name: "Digest" }, { id: "r2", runOn: "seira", name: "Local" }],
      runs: [
        { id: "q", runOn: "cloud", status: "queued" }, { id: "w", runOn: "cloud", status: "waiting" },
        { id: "d", runOn: "cloud", status: "done" }, { id: "s", runOn: "seira", status: "queued" },
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
    write("webhooks.json", { version: 1, webhooks: [{ id: "w", runOn: "cloud" }, { id: "x", runOn: "seira" }], deliveries: [], deleted: [{ at: 1, webhook: { id: "gone", runOn: "cloud" } }] });
    write("app-triggers.json", { version: 1, pollerId: "poller-12345", cursor: 0, triggers: [{ id: "t", runOn: "cloud" }], attempts: [], deleted: [] });
    const counts = retireBoatFromFiles(dir, log);
    expect([counts.webhooks, counts.appTriggers]).toEqual([2, 1]);
    expect(read("webhooks.json").webhooks.map((hook: { runOn: string }) => hook.runOn)).toEqual(["seira", "seira"]);
    expect(read("webhooks.json").deleted[0].webhook.runOn).toBe("seira");
    expect(read("app-triggers.json").triggers[0].runOn).toBe("seira");
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
