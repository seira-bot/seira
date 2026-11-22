// Which protection the server reports: the kernel's slice, the watchdog standing in for it, or none (AC-07).
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ protection: "none" as "slice" | "watchdog" | "none" }));
vi.mock("./memory-fence.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./memory-fence.ts")>();
  return { ...original, memoryFence: { ...original.memoryFence, protection: () => state.protection, active: () => state.protection === "slice", wanted: () => state.protection !== "none" } };
});

import { botMemoryCapReport, botMemoryStatus, startBotMemoryCap, useBotMemoryWatchdog } from "./bot-memory-cap.ts";
import { defaultBotBudget, GIB, machineMemoryBytes } from "./bot-memory-budget.ts";
import type { GateHost } from "./process-room.ts";

function start(gate: GateHost, env: NodeJS.ProcessEnv) {
  return startBotMemoryCap({
    gate, turns: () => undefined, owners: () => [], botName: (id) => id, closeBrowsers: async () => undefined, list: () => [], startOf: () => null,
    pressure: () => ({ room: 1, short: false, freeBytes: null }), env, memoryBytes: 16 * GIB, log: () => undefined, platform: "linux",
  });
}

describe("what Settings shows of the limit", () => {
  it("shows a row only where the slice or the watchdog protects bots", () => {
    state.protection = "none";
    expect(botMemoryStatus({}, { SEIRA_DESKTOP_PARENT: "1" })).toBeUndefined();
    state.protection = "slice";
    expect(botMemoryStatus({}, {})).toMatchObject({ protection: "slice" });
    state.protection = "watchdog";
    expect(botMemoryStatus({}, {})).toMatchObject({ protection: "watchdog" });
  });
});

describe("the protection in force", () => {
  afterEach(() => useBotMemoryWatchdog(null));

  it("is the slice where the kernel limit works, with the watchdog on standby", () => {
    state.protection = "slice";
    const dog = start("desktop", { SEIRA_BOT_MEMORY_MAX_MB: "auto" });
    try {
      const report = botMemoryCapReport();
      expect(report).toMatchObject({ protection: "slice", mb: null, mode: null, rung: "none" });
      expect(report.budgetGb).toBe(Math.round((defaultBotBudget(machineMemoryBytes()) / GIB) * 10) / 10);
    } finally { dog?.stop(); }
  });

  it("takes over at run time when the kernel limit stops working, and hands back when it works again", () => {
    state.protection = "slice";
    const lines: string[] = [];
    const timer = vi.spyOn(globalThis, "setInterval");
    const dog = startBotMemoryCap({
      gate: "desktop", turns: () => undefined, owners: () => [], botName: (id) => id, closeBrowsers: async () => undefined, list: () => [], startOf: () => null,
      pressure: () => ({ room: 1, short: false, freeBytes: null }), env: { SEIRA_BOT_MEMORY_MAX_MB: "auto" }, memoryBytes: 64 * GIB, log: (line) => lines.push(line), platform: "linux",
    });
    try {
      expect(dog).not.toBeNull();
      expect(timer).toHaveBeenCalledTimes(1);
      expect(lines).toEqual([]);
      state.protection = "watchdog";
      expect(botMemoryCapReport()).toMatchObject({ protection: "watchdog", mode: "enforce", rung: "watchdog" });
      expect(botMemoryCapReport().budgetGb).not.toBeNull();
      state.protection = "slice";
      expect(botMemoryCapReport()).toMatchObject({ protection: "slice", mb: null });
    } finally { dog?.stop(); timer.mockRestore(); }
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
