import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { approvalModeFor } from "../shared/approval-mode.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { RoutineManager } from "./routines.ts";
import { Store } from "./store.ts";
import { createTeamBackup, importTeamBackup } from "./team-backup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function backupOfOneBot() {
  const store = new Store(selection);
  const routines = new RoutineManager({
    botState: (id) => store.bot(id) ? "ready" : "missing",
    goalState: () => "missing",
    createTask: (id, title) => store.createTask(id, title),
    startTurn: async () => { throw new Error("Import must never run a bot"); },
  });
  const source = store.createBot({ name: "Mira", section: "Ops" }, { seedMessages: false });
  store.patchBot(source.id, { approvalMode: "full", autoApprove: true });
  return { store, routines, backup: createTeamBackup(store, [], "Ops team") };
}

describe("a bot a team backup restore creates starts at the saved New bot level", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it.each(["ask", "full"] as const)("starts at %s when that level is passed in", (level) => {
    const { store, routines, backup } = backupOfOneBot();
    const restored = importTeamBackup(store, routines, backup, selection(), { newBotApproval: level }).bots.map((bot) => store.bot(bot.id)!);
    expect(restored.length).toBeGreaterThan(0);
    for (const bot of restored) {
      expect(approvalModeFor(bot)).toBe(level);
      expect(bot.autoApprove).toBe(false);
    }
  });

  it("keeps the workspace default when no level is passed in", () => {
    const { store, routines, backup } = backupOfOneBot();
    const restored = importTeamBackup(store, routines, backup, selection()).bots.map((bot) => store.bot(bot.id)!);
    expect(restored.length).toBeGreaterThan(0);
    for (const bot of restored) {
      expect(bot.approvalMode).toBeUndefined();
      expect(bot.autoApprove).toBe(false);
    }
  });

  it("never takes the level from the file", () => {
    const { store, routines, backup } = backupOfOneBot();
    for (const source of backup.bots) Object.assign(source, { approvalMode: "full", autoApprove: true });
    const restored = importTeamBackup(store, routines, backup, selection(), { newBotApproval: "ask" }).bots.map((bot) => store.bot(bot.id)!);
    expect(restored.length).toBeGreaterThan(0);
    for (const bot of restored) {
      expect(approvalModeFor(bot)).toBe("ask");
      expect(bot.autoApprove).toBe(false);
    }
  });
});
