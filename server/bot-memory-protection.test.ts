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

function start(gate: GateHost, env: NodeJS.ProcessEnv, over: Partial<Parameters<typeof startBotMemoryCap>[0]> = {}) {
  return startBotMemoryCap({
    gate, turns: () => undefined, owners: () => [], botName: (id) => id, closeBrowsers: async () => undefined, list: () => [], startOf: () => null,
    pressure: () => ({ room: 1, short: false, freeBytes: null }), env, memoryBytes: 16 * GIB, log: () => undefined, platform: "linux", ...over,
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

  it("shows the row on Windows and macOS where the job or the watchdog enforces the limit (AC-11)", () => {
    expect(botMemoryStatus({}, {}, "job")).toMatchObject({ protection: "job" });
    expect(botMemoryStatus({}, {}, "watchdog")).toMatchObject({ protection: "watchdog" });
    expect(botMemoryStatus({}, {}, "none")).toBeUndefined();
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

  it("off Linux reports what the job or the watchdog enforces, and its stops", () => {
    const budgetGb = Math.round((defaultBotBudget(machineMemoryBytes()) / GIB) * 10) / 10;
    for (const live of ["job", "watchdog"] as const) {
      expect(start("desktop", {}, { platform: "win32", protection: () => live, guardStops: () => 2 })).toBeNull();
      expect(botMemoryCapReport()).toMatchObject({ protection: live, rung: "none", mb: null, stops: 2, budgetGb });
    }
    expect(start("desktop", {}, { platform: "darwin", protection: () => "none", guardStops: () => 5 })).toBeNull();
    expect(botMemoryCapReport()).toMatchObject({ protection: "none", budgetGb: null, stops: 0 });
  });

  it("is none where the limit is not wanted, and the desktop gate keeps the old log cap off", () => {
    state.protection = "none";
    expect(start("desktop", {})).toBeNull();
    expect(botMemoryCapReport()).toMatchObject({ protection: "none", mb: null, budgetGb: null });
  });
});
