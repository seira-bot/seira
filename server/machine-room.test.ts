import { describe, expect, it, vi } from "vitest";

import { HEAVY_WORK_PROMPT } from "./heavy-work-prompt.ts";
import { botShare, currentBotLimit, nodeBudgetSource, readMachineRoom, suggestedWorkers, type BotLimit, type BudgetSource } from "./machine-room.ts";
import { buildSystemPrompt, longCommandsPrompt } from "./system-prompt.ts";

const GB = 1024 ** 3;
const source = (over: Partial<BudgetSource> = {}): BudgetSource => ({
  memory: () => ({ totalBytes: 16 * GB, freeBytes: 9 * GB }), cpus: () => 8, pressure: () => 1.5, processes: () => [], ...over,
});

describe("suggestedWorkers", () => {
  it.each([
    [9 * GB, 8, 6], [9 * GB, 4, 3], [9 * GB, 1, 1], [1 * GB, 8, 1], [0, 8, 1], [30 * GB, 16, 15], [3 * GB, 8, 2], [4.4 * GB, 8, 2], [null, 8, 1], [9 * GB, null, 6],
  ])("free %s, cpus %s gives %s", (free, cpus, workers) => expect(suggestedWorkers(free, cpus)).toBe(workers));
});

describe("readMachineRoom", () => {
  it("reports memory in GB, CPUs and workers (AC-02)", () => {
    expect(readMachineRoom(source())).toEqual({
      memoryGB: { total: 16, used: 7, free: 9 }, cpus: 8, memoryPressurePercent: 1.5, heavyWorkRunning: [], suggestedWorkers: 6,
    });
  });
  it("lists heavy work over 1 GB by program only, largest first (AC-04)", () => {
    const room = readMachineRoom(source({ processes: () => [{ name: "node", rssBytes: 2.04 * GB }, { name: "ffmpeg", rssBytes: 0.5 * GB }, { name: "jest", rssBytes: 3 * GB }] }));
    expect(room.heavyWorkRunning).toEqual([{ program: "jest", gb: 3 }, { program: "node", gb: 2 }]);
  });
  it("marks what it cannot read as unknown, never 0 (AC-05)", () => {
    const room = readMachineRoom(source({ memory: () => null, cpus: () => null, pressure: () => null, processes: () => null }));
    expect(room).toEqual({ memoryGB: { total: "unknown", used: "unknown", free: "unknown" }, cpus: "unknown", memoryPressurePercent: "unknown", heavyWorkRunning: "unknown", suggestedWorkers: 1 });
  });
  it("reads no process list and no pressure off Linux (AC-05)", () => {
    const off = nodeBudgetSource({ platform: "win32", read: () => { throw new Error("no files off Linux"); } });
    expect(off.processes()).toBeNull();
    expect(off.pressure()).toBeNull();
    expect(readMachineRoom(off).heavyWorkRunning).toBe("unknown");
  });
  it("counts only what the server started, and skips exited ones", () => {
    const stat = (pid: number, comm: string, ppid: number, state: string, bytes: number) =>
      `${pid} (${comm}) ${state} ${ppid} ${pid} ${pid} 0 0 0 0 0 0 0 0 0 0 0 0 1 0 100 0 ${Math.round(bytes / 4096)} 0`;
    const files: Record<string, string> = {
      "/proc/1/stat": stat(1, "init", 0, "S", 1e6), "/proc/50/stat": stat(50, "seira", 1, "S", 1e8),
      "/proc/60/stat": stat(60, "jest", 50, "S", 3 * GB), "/proc/61/stat": stat(61, "worker", 60, "S", 2 * GB),
      "/proc/62/stat": stat(62, "dead", 60, "Z", 5 * GB), "/proc/70/stat": stat(70, "chrome", 1, "S", 4 * GB),
    };
    const read = (path: string) => files[path] ?? null;
    const found = nodeBudgetSource({ platform: "linux", serverPid: 50, read, list: () => ["1", "50", "60", "61", "62", "70", "self"] }).processes();
    expect(found?.map((one) => one.name).sort()).toEqual(["jest", "worker"]);
  });
  it("finishes without starting a program, fast (AC-06)", () => {
    const started = performance.now();
    readMachineRoom();
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("the memory limit for all bots", () => {
  const limited = (limit: BotLimit | null, free = 20) => source({ memory: () => ({ totalBytes: 32 * GB, freeBytes: free * GB }), botLimit: () => limit });

  it("reports the budget less what bot work uses, not the computer's free memory, under the kernel limit", () => {
    const room = readMachineRoom(limited({ budgetBytes: 24 * GB, usedBytes: 14 * GB }));
    expect(room.memoryGB).toEqual({ total: 24, used: 14, free: 10, sharedBy: "all bots" });
    expect(room.suggestedWorkers).toBe(6);
  });
  it("keeps the computer's free memory when that is smaller", () => {
    expect(readMachineRoom(limited({ budgetBytes: 24 * GB, usedBytes: 2 * GB }, 5)).memoryGB).toEqual({ total: 24, used: 19, free: 5, sharedBy: "all bots" });
  });
  it("holds free memory to the budget where only the budget is known", () => {
    expect(readMachineRoom(limited({ budgetBytes: 24 * GB, usedBytes: null }, 28)).memoryGB).toEqual({ total: 24, used: 0, free: 24, sharedBy: "all bots" });
    expect(readMachineRoom(limited({ budgetBytes: 24 * GB, usedBytes: null })).memoryGB.free).toBe(20);
  });
  it("reports no room and one worker when bot work is over the budget", () => {
    const room = readMachineRoom(limited({ budgetBytes: 24 * GB, usedBytes: 26 * GB }));
    expect(room.memoryGB).toMatchObject({ total: 24, free: 0 });
    expect(room.suggestedWorkers).toBe(1);
  });
  it("gives the same answer as before with no limit", () => {
    expect(readMachineRoom(limited(null)).memoryGB).toEqual({ total: 32, used: 12, free: 20 });
    expect(botShare({ totalBytes: 8 * GB, freeBytes: 3 * GB }, null)).toEqual({ totalBytes: 8 * GB, freeBytes: 3 * GB });
  });
  it("holds total memory to the computer's when the budget is larger", () => {
    expect(botShare({ totalBytes: 8 * GB, freeBytes: 3 * GB }, { budgetBytes: 12 * GB, usedBytes: 1 * GB })).toEqual({ totalBytes: 8 * GB, freeBytes: 3 * GB });
  });
  it("names nothing internal in the answer", () => {
    const text = JSON.stringify(readMachineRoom(limited({ budgetBytes: 24 * GB, usedBytes: 14 * GB })));
    expect(text).not.toMatch(/slice|cgroup|fence|watchdog|systemd|\//i);
  });
});

describe("currentBotLimit", () => {
  const fence = (protection: "slice" | "watchdog" | "none", current: number | null = 14 * GB, applied: number | null = 24 * GB) =>
    ({ protection: () => protection, budgetBytes: () => applied, sliceCurrent: vi.fn(() => current) });
  const linux = (one: ReturnType<typeof fence>, budget: () => number | null = () => 30 * GB) => currentBotLimit({ platform: "linux", fence: one, budget });

  it("reads the limit in force and what bot work uses under it", () => {
    expect(linux(fence("slice"))).toEqual({ budgetBytes: 24 * GB, usedBytes: 14 * GB });
  });
  it("uses the budget alone when what bot work uses cannot be read", () => {
    expect(linux(fence("slice", null))).toEqual({ budgetBytes: 24 * GB, usedBytes: null });
  });
  it("uses the budget alone under the watchdog, without reading bot work's use", () => {
    const watched = fence("watchdog");
    expect(linux(watched, () => 22 * GB)).toEqual({ budgetBytes: 22 * GB, usedBytes: null });
    expect(watched.sliceCurrent).not.toHaveBeenCalled();
  });
  it("is null with no protection or no budget", () => {
    expect(linux(fence("none"))).toBeNull();
    expect(linux(fence("watchdog"), () => null)).toBeNull();
    expect(linux(fence("slice", 1 * GB, null), () => null)).toBeNull();
  });
  it("reads the Windows and macOS limit and its use from the guard", () => {
    const guard = (protection: "job" | "watchdog" | "none") => ({ protection: () => protection, budgetBytes: () => 12 * GB, usedBytes: () => 5 * GB });
    const unused = fence("slice");
    for (const platform of ["win32", "darwin"] as const) {
      expect(currentBotLimit({ platform, guard: guard("job"), fence: unused })).toEqual({ budgetBytes: 12 * GB, usedBytes: 5 * GB });
      expect(currentBotLimit({ platform, guard: guard("watchdog"), fence: unused })).toEqual({ budgetBytes: 12 * GB, usedBytes: 5 * GB });
      expect(currentBotLimit({ platform, guard: guard("none"), fence: unused })).toBeNull();
    }
    expect(unused.sliceCurrent).not.toHaveBeenCalled();
  });
  it("is what the default source reports, unless one is given", () => {
    expect(nodeBudgetSource({ botLimit: () => null }).botLimit?.()).toBeNull();
    expect(readMachineRoom(nodeBudgetSource({ botLimit: () => ({ budgetBytes: 1 * GB, usedBytes: 0 }) })).memoryGB).toMatchObject({ total: 1, sharedBy: "all bots" });
  });
});

describe("the heavy-work part of the system prompt (AC-01)", () => {
  it("is at most 1,200 bytes and has no number that changes", () => {
    expect(Buffer.byteLength(HEAVY_WORK_PROMPT, "utf8")).toBeLessThanOrEqual(1200);
    expect(HEAVY_WORK_PROMPT).toContain("machine_budget");
    expect(HEAVY_WORK_PROMPT).toContain("too_small");
    expect(HEAVY_WORK_PROMPT).toContain("Full access");
  });
  it("is the same bytes in the stable half every turn", () => {
    for (const kind of [null, "local", "vm-private", "vps"] as const) expect(longCommandsPrompt(kind)).toContain(HEAVY_WORK_PROMPT);
    const build = () => buildSystemPrompt("persona", "", [{ id: "shell", label: "Long-running commands", text: longCommandsPrompt("local") }]);
    const [a, b] = [build(), build()];
    expect(a.stable).toBe(b.stable);
    expect(a.stable).toContain(HEAVY_WORK_PROMPT);
    expect(a.volatile).not.toContain(HEAVY_WORK_PROMPT);
  });
});
