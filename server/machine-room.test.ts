import { describe, expect, it } from "vitest";

import { HEAVY_WORK_PROMPT } from "./heavy-work-prompt.ts";
import { nodeBudgetSource, readMachineRoom, suggestedWorkers, type BudgetSource } from "./machine-room.ts";
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

describe("the heavy-work part of the system prompt (AC-01)", () => {
  it("is at most 1,200 bytes and has no number that changes", () => {
    expect(Buffer.byteLength(HEAVY_WORK_PROMPT, "utf8")).toBeLessThanOrEqual(1200);
    expect(HEAVY_WORK_PROMPT).toContain("machine_budget");
  });
  it("is the same bytes in the stable half every turn", () => {
    for (const kind of [null, "local", "vm-private", "box"] as const) expect(longCommandsPrompt(kind)).toContain(HEAVY_WORK_PROMPT);
    const build = () => buildSystemPrompt("persona", "", [{ id: "shell", label: "Long-running commands", text: longCommandsPrompt("local") }]);
    const [a, b] = [build(), build()];
    expect(a.stable).toBe(b.stable);
    expect(a.stable).toContain(HEAVY_WORK_PROMPT);
    expect(a.volatile).not.toContain(HEAVY_WORK_PROMPT);
  });
});
