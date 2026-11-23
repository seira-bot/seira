// A bot saved on Boat is read at start as the same bot without it, and the file is rewritten once.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const file = () => join(DATA_DIR, "bots.json");
const saved = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(file(), "utf8"));
const edit = (change: (bots: Array<Record<string, any>>) => void) => {
  const bots = saved(); change(bots); writeFileSync(file(), JSON.stringify(bots));
};

describe("bots saved while Boat was a cloud computer", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("move to their VPS when it is set up, and to no computer when it is not", () => {
    const store = new Store(selection);
    const withVps = store.createBot({ name: "With VPS" }), without = store.createBot({ name: "Without" });
    edit((bots) => {
      Object.assign(bots.find((bot) => bot.id === withVps.id)!, { computer: "cloud", cloudBackend: "box", vpsAlias: "my-vps" });
      Object.assign(bots.find((bot) => bot.id === without.id)!, { computer: "cloud" });
    });
    const reloaded = new Store(selection);
    expect(reloaded.bot(withVps.id)).toMatchObject({ computer: "cloud", cloudBackend: "vps", vpsAlias: "my-vps" });
    const off: BotRecord = reloaded.bot(without.id)!;
    expect(off.computer).toBe("off");
    expect(off.cloudBackend).toBeUndefined();
    // Saved at once: a crash right after start does not bring it back.
    expect(saved().find((bot) => bot.id === without.id)).toMatchObject({ computer: "off" });
  });

  it("drop the cloud pin a turn made on its own where there is no VPS, and keep one the person chose", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Pins" });
    edit((bots) => {
      const record = bots.find((entry) => entry.id === bot.id)!;
      record.computer = "cloud";
      record.cloudBackend = "box";
      record.tasks = [
        { threadId: bot.threadId, surface: "cloud", surfaceSource: "user" },
        { threadId: "auto-thread", surface: "cloud", surfaceSource: "auto" },
      ];
    });
    const tasks = new Store(selection).bot(bot.id)!.tasks ?? [];
    expect(tasks.find((task) => task.threadId === bot.threadId)).toMatchObject({ surface: "cloud", surfaceSource: "user" });
    expect(tasks.find((task) => task.threadId === "auto-thread")?.surface).toBeUndefined();
  });

  it("load the same the second time, and leave the file as it was", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Once" });
    edit((bots) => Object.assign(bots.find((entry) => entry.id === bot.id)!, { computer: "cloud", cloudBackend: "box" }));
    new Store(selection);
    const once = readFileSync(file(), "utf8");
    new Store(selection);
    expect(readFileSync(file(), "utf8")).toBe(once);
  });

  it("leave a bot that never used Boat exactly as it was", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Plain" });
    edit((bots) => Object.assign(bots.find((entry) => entry.id === bot.id)!, { computer: "cloud", cloudBackend: "vps", vpsAlias: "my-vps" }));
    expect(new Store(selection).bot(bot.id)).toMatchObject({ computer: "cloud", cloudBackend: "vps", vpsAlias: "my-vps" });
  });
});
