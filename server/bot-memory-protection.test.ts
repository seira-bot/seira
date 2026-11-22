// Which protection the server reports: the kernel's slice, the watchdog standing in for it, or none (AC-07).
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ protection: "none" as "slice" | "watchdog" | "none" }));
vi.mock("./memory-fence.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./memory-fence.ts")>();
  return { ...original, memoryFence: { ...original.memoryFence, protection: () => state.protection, active: () => state.protection === "slice" } };
});

import { botMemoryCapReport, startBotMemoryCap, useBotMemoryWatchdog } from "./bot-memory-cap.ts";
import { defaultBotBudget, GIB, machineMemoryBytes } from "./bot-memory-budget.ts";
import type { GateHost } from "./process-room.ts";

function start(gate: GateHost, env: NodeJS.ProcessEnv) {
  return startBotMemoryCap({
    gate, turns: () => undefined, owners: () => [], botName: (id) => id, closeBrowsers: async () => undefined, list: () => [], startOf: () => null,
    pressure: () => ({ room: 1, short: false, freeBytes: null }), env, memoryBytes: 16 * GIB, log: () => undefined, platform: "linux",
  });
}

describe("the protection in force", () => {
  afterEach(() => useBotMemoryWatchdog(null));

  it("is the slice where the kernel limit works, with no watchdog", () => {
    state.protection = "slice";
    expect(start("desktop", { SEIRA_BOT_MEMORY_MAX_MB: "auto" })).toBeNull();
    const report = botMemoryCapReport();
    expect(report.protection).toBe("slice");
    expect(report.budgetGb).toBe(Math.round((defaultBotBudget(machineMemoryBytes()) / GIB) * 10) / 10);
  });

  it("is the watchdog, enforcing the whole budget, where the limit is wanted and missing", () => {
    state.protection = "watchdog";
    const dog = start("desktop", { SEIRA_BOT_MEMORY_MAX_MB: "auto" });
    try {
      expect(dog).not.toBeNull();
      const report = botMemoryCapReport();
      expect(report).toMatchObject({ protection: "watchdog", mode: "enforce" });
      expect(report.budgetGb).not.toBeNull();
    } finally { dog?.stop(); }
  });

  it("is none where the limit is not wanted, and the desktop gate keeps the old log cap off", () => {
    state.protection = "none";
    expect(start("desktop", {})).toBeNull();
    expect(botMemoryCapReport()).toMatchObject({ protection: "none", mb: null, budgetGb: null });
  });
});
