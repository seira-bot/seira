import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BOT_AT_WORK_BYTES, botsAtOnce, capacityCardLine, capacityHoldText, capacityNoteText, readMachineSpec, taskFit, TASK_KINDS, teamCapacity, type MachineSpec, type TaskKind } from "./machine-capacity.ts";
import { ENGINE_DEFAULT_BYTES } from "./engine-memory.ts";
import type { BudgetSource } from "./machine-room.ts";

const GB = 1024 ** 3, MB = 1024 ** 2;
const spec = (over: Partial<MachineSpec> = {}): MachineSpec => ({
  totalMemoryBytes: 16 * GB, botMemoryBytes: 12 * GB, freeBotMemoryBytes: 12 * GB, cpus: 8, diskFreeBytes: 200 * GB, os: "linux", ...over,
});

describe("bots at the same time (AC-01)", () => {
  it("is the memory for bots divided by 700 MB, rounded down", () => {
    expect(botsAtOnce(5 * GB)).toBe(7);
    expect(botsAtOnce(700 * MB)).toBe(1);
    expect(botsAtOnce(1400 * MB)).toBe(2);
  });
  it("is at least 1", () => {
    expect(botsAtOnce(0)).toBe(1);
    expect(botsAtOnce(100 * MB)).toBe(1);
  });
  it("counts a bot at work as the engine size the turn gate uses", () => {
    expect(BOT_AT_WORK_BYTES).toBe(ENGINE_DEFAULT_BYTES);
  });
});

describe("team verdict (AC-02)", () => {
  const small = spec({ botMemoryBytes: 5 * GB });
  it.each([[1, "ok"], [14, "ok"], [15, "tight"], [28, "tight"], [29, "over"], [100, "over"]] as const)("rates %i bots after the setup as %s", (after, verdict) => {
    expect(teamCapacity(small, after)).toMatchObject({ verdict, botsAtOnce: 7, botsAfter: after });
  });
  it("is null when the memory for bots is unknown (AC-06)", () => {
    expect(teamCapacity(spec({ botMemoryBytes: null }), 50)).toBeNull();
  });
});

describe("the fit of a heavy job (AC-08, AC-09)", () => {
  it("is ok on a large computer for every fixed kind", () => {
    for (const task of ["tests", "e2e_tests", "build", "mobile_build", "docker", "video"] as TaskKind[]) expect(taskFit(spec(), task).verdict).toBe("ok");
  });
  it("gives the memory and disk the job needs and one lighter way", () => {
    const fit = taskFit(spec(), "e2e_tests");
    expect(fit.needs).toEqual({ memoryGB: { min: 4, comfortable: 8 }, diskGB: 3 });
    expect(fit.lighter).toContain("one spec file");
  });
  it("is too small when the memory for bots is below the minimum", () => {
    expect(taskFit(spec({ botMemoryBytes: 3 * GB, freeBotMemoryBytes: 3 * GB }), "e2e_tests").verdict).toBe("too_small");
    expect(taskFit(spec({ botMemoryBytes: 5 * GB }), "mobile_build").verdict).toBe("too_small");
  });
  it("is too small when the free disk is below what the job needs", () => {
    expect(taskFit(spec({ diskFreeBytes: 5 * GB }), "mobile_build").verdict).toBe("too_small");
    expect(taskFit(spec({ diskFreeBytes: 0.5 * GB }), "tests").verdict).toBe("too_small");
  });
  it("is tight below the comfortable memory, or when free memory now is below it", () => {
    expect(taskFit(spec({ botMemoryBytes: 6 * GB, freeBotMemoryBytes: 6 * GB }), "e2e_tests").verdict).toBe("tight");
    expect(taskFit(spec({ freeBotMemoryBytes: 2 * GB }), "e2e_tests").verdict).toBe("tight");
  });
  it("is unknown when the memory for bots is unknown, and ignores an unknown disk", () => {
    expect(taskFit(spec({ botMemoryBytes: null }), "build").verdict).toBe("unknown");
    expect(taskFit(spec({ diskFreeBytes: null }), "mobile_build").verdict).toBe("ok");
  });
  it("sizes a local model by its size, and by a default without one", () => {
    expect(taskFit(spec(), "local_model", { sizeGb: 4 }).needs).toEqual({ memoryGB: { min: 6, comfortable: 9 }, diskGB: 4 });
    expect(taskFit(spec(), "local_model").needs).toEqual({ memoryGB: { min: 8, comfortable: 12 }, diskGB: 0 });
    expect(taskFit(spec({ botMemoryBytes: 5 * GB }), "local_model", { sizeGb: 8 }).verdict).toBe("too_small");
  });
  it("sizes browsers by their count and large files by their size", () => {
    expect(taskFit(spec(), "browsers", { count: 10 }).needs).toEqual({ memoryGB: { min: 4, comfortable: 6 }, diskGB: 1 });
    expect(taskFit(spec(), "browsers").needs?.memoryGB.min).toBe(2);
    expect(taskFit(spec(), "large_files", { sizeGb: 3 }).needs).toEqual({ memoryGB: { min: 6, comfortable: 9 }, diskGB: 6 });
    expect(taskFit(spec(), "large_files").needs).toEqual({ memoryGB: { min: 2, comfortable: 4 }, diskGB: 0 });
  });
  it("maps more_bots to the team verdict", () => {
    const small = spec({ botMemoryBytes: 5 * GB });
    expect(taskFit(small, "more_bots", { botsNow: 5, count: 5 }).verdict).toBe("ok");
    expect(taskFit(small, "more_bots", { botsNow: 10, count: 10 }).verdict).toBe("tight");
    expect(taskFit(small, "more_bots", { botsNow: 20, count: 20 }).verdict).toBe("too_small");
    expect(taskFit(spec({ botMemoryBytes: null }), "more_bots", { count: 3 }).verdict).toBe("unknown");
  });
  it("has one lighter way for every kind", () => {
    for (const task of TASK_KINDS) expect(taskFit(spec(), task).lighter.length).toBeGreaterThan(10);
  });
});

describe("reading the machine (AC-06, AC-07)", () => {
  const source = (over: Partial<BudgetSource> = {}): BudgetSource => ({
    memory: () => ({ totalBytes: 8 * GB, freeBytes: 6 * GB }), cpus: () => 4, pressure: () => null, processes: () => null, botLimit: () => null, ...over,
  });
  const disk = () => ({ bavail: 100, bsize: 1 * GB });
  it("reads memory, the share for bots, processors, disk and system", () => {
    const read = readMachineSpec({ dataDir: "x", source: source(), statfs: disk, platform: "win32" });
    expect(read).toMatchObject({ totalMemoryBytes: 8 * GB, cpus: 4, diskFreeBytes: 100 * GB, os: "windows" });
    expect(read.botMemoryBytes).toBeCloseTo(5 * GB);
  });
  it("uses the limit for all bots and what is free of it", () => {
    const read = readMachineSpec({ dataDir: "x", source: source({ botLimit: () => ({ budgetBytes: 4 * GB, usedBytes: 1 * GB }) }), statfs: disk, platform: "darwin" });
    expect(read).toMatchObject({ botMemoryBytes: 4 * GB, freeBotMemoryBytes: 3 * GB, os: "macos" });
  });
  it("gives null, never 0, for a value that cannot be read", () => {
    const read = readMachineSpec({ dataDir: "x", source: source({ memory: () => null, cpus: () => null }), statfs: () => { throw new Error("no"); }, platform: "freebsd" });
    expect(read).toEqual({ totalMemoryBytes: null, botMemoryBytes: null, freeBotMemoryBytes: null, cpus: null, diskFreeBytes: null, os: "other" });
  });
  it("starts no program", () => {
    expect(readFileSync(new URL("./machine-capacity.ts", import.meta.url), "utf8")).not.toContain("child_process");
  });
});

describe("the texts", () => {
  const capacity = teamCapacity(spec({ botMemoryBytes: 5 * GB }), 30)!;
  it("names the bots at the same time and the bots after the setup", () => {
    expect(capacityCardLine(capacity)).toContain("about 7 bots at work at the same time");
    expect(capacityCardLine(capacity)).toContain("there are 30 bots");
    expect(capacityNoteText(capacity)).toContain("team now has 30 bots");
  });
  it("tells the bot what to do on hold, with the size when it is known", () => {
    const hold = capacityHoldText(capacity);
    expect(hold).toContain("Nothing was created.");
    expect(hold).toContain("5 GB of memory for bots, 8 processors");
    expect(hold).toContain("capacity_ok true");
    expect(capacityHoldText(teamCapacity(spec({ botMemoryBytes: 5 * GB, cpus: null }), 30)!)).toContain("(5 GB of memory for bots)");
  });
});
