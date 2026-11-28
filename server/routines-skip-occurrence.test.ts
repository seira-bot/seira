import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setOccurrenceSkip } from "./routine-skip-occurrence.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 19, 8, 0, 0).getTime();
const NINE = START + HOUR;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "seira-skip-routines-"));
  dirs.push(dir);
  let now = START, task = 0;
  const started: string[] = [], emitted: any[] = [];
  const startWorkflow = vi.fn(async () => {});
  const options = {
    file: join(dir, "routines.json"),
    now: () => now,
    emit: (payload: Record<string, unknown>) => emitted.push(payload),
    botState: () => "ready" as const,
    createTask: () => ({ threadId: `thread-${++task}` }),
    joinConversation: (run: RoutineRun) => run.sourceThreadId ?? null,
    startTurn: async (_botId: string, threadId: string) => { started.push(threadId); },
    workflowCopy: () => ({ workflowId: "wf-1", prompt: "Run the workflow.", botId: "ana", botIds: ["ana"] }),
    startWorkflow,
  };
  const manager = new RoutineManager(options as never);
  const daily = (extra: Record<string, unknown> = {}) => manager.create({
    name: "Morning", prompt: "Say hello.", botId: "scout", schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...extra,
  } as never);
  const skip = (id: string, at: number, on = true) => setOccurrenceSkip(manager, id, at, on, now);
  return { manager, started, emitted, options, startWorkflow, daily, skip, at: (next: number) => { now = next; } };
}

describe("skipping one occurrence of a routine", () => {
  it("makes no run for the skipped time, and runs the next day", async () => {
    const h = harness();
    const routine = h.daily();
    expect(routine.nextRunAt).toBe(NINE);
    const skipped = h.skip(routine.id, NINE) as { routine: any };
    expect(skipped.routine).toMatchObject({ skippedOccurrences: [NINE], nextRunAt: NINE + DAY, updatedAt: routine.updatedAt });
    h.at(NINE + 1_000); await h.manager.tick();
    expect(h.started).toEqual([]);
    expect(h.manager.listRuns()).toEqual([]);
    h.at(NINE + DAY + 1_000); await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRoutines()[0].skippedOccurrences).toBeUndefined();
  });

  it("keeps the later occurrences, and skips a time that is not the next one", async () => {
    const h = harness();
    const routine = h.daily();
    h.skip(routine.id, NINE + DAY);
    expect(h.manager.listRoutines()[0]).toMatchObject({ nextRunAt: NINE, skippedOccurrences: [NINE + DAY] });
    h.at(NINE + 1_000); await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRoutines()[0]).toMatchObject({ nextRunAt: NINE + 2 * DAY });
    h.at(NINE + DAY + 1_000); await h.manager.tick();
    expect(h.started).toHaveLength(1);
  });

  it("does not count as a missed run or in skippedRuns", async () => {
    const h = harness();
    const routine = h.daily();
    h.skip(routine.id, NINE);
    h.at(NINE + 1_000); await h.manager.tick();
    expect(h.manager.listRuns().filter((run) => run.status === "missed")).toEqual([]);
    expect(h.manager.listRoutines()[0].skippedRuns).toBeUndefined();
    expect(h.manager.listRoutines()[0].lastSkippedAt).toBeUndefined();
  });

  it("makes no workflow run for a routine that runs a workflow", async () => {
    const h = harness();
    const routine = h.manager.create({ name: "Morning", workflowId: "wf-1", prompt: "x", botId: "x", schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } } as never);
    h.skip(routine.id, NINE);
    h.at(NINE + 1_000); await h.manager.tick();
    expect(h.startWorkflow).not.toHaveBeenCalled();
    h.at(NINE + DAY + 1_000); await h.manager.tick();
    expect(h.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("does not run a skipped time that the scheduler finds due, even when nextRunAt was not moved", async () => {
    const h = harness();
    const routine = h.daily();
    (h.manager as any).routines[0].skippedOccurrences = [NINE];
    h.at(NINE + 1_000); await h.manager.tick();
    expect(h.started).toEqual([]);
    expect(h.manager.listRoutines()[0]).toMatchObject({ id: routine.id, nextRunAt: NINE + DAY });
  });

  it("is undone before the time, so the routine runs again", async () => {
    const h = harness();
    const routine = h.daily();
    h.skip(routine.id, NINE);
    const undone = h.skip(routine.id, NINE, false) as { routine: any };
    expect(undone.routine.skippedOccurrences).toBeUndefined();
    expect(undone.routine.nextRunAt).toBe(NINE);
    h.at(NINE + 1_000); await h.manager.tick();
    expect(h.started).toHaveLength(1);
  });

  it("keeps a later next run when an undone time is after it", () => {
    const h = harness();
    const routine = h.daily();
    h.skip(routine.id, NINE + DAY);
    h.skip(routine.id, NINE + DAY, false);
    expect(h.manager.listRoutines()[0]).toMatchObject({ nextRunAt: NINE });
  });

  it("returns the routine when the undone time is not in the list, and null for a missing routine", () => {
    const h = harness();
    const routine = h.daily();
    expect(h.skip(routine.id, NINE, false)).toMatchObject({ routine: { id: routine.id, nextRunAt: NINE } });
    expect(h.skip("missing", NINE, false)).toBeNull();
    expect(h.skip("missing", NINE)).toBeNull();
  });

  it("refuses a time that is not an occurrence, a past time, and a routine that is off", () => {
    const h = harness();
    const routine = h.daily();
    expect(h.skip(routine.id, NINE + 1)).toMatchObject({ error: expect.stringContaining("does not run") });
    expect(h.skip(routine.id, START - DAY)).toMatchObject({ error: expect.stringContaining("passed") });
    h.manager.update(routine.id, { enabled: false });
    expect(h.skip(routine.id, NINE)).toMatchObject({ error: expect.stringContaining("off") });
  });

  it("refuses a routine that runs once", () => {
    const h = harness();
    const once = h.manager.create({ name: "Once", prompt: "x", botId: "scout", schedule: { type: "once", at: NINE } } as never);
    expect(h.skip(once.id, NINE)).toMatchObject({ error: expect.stringContaining("only once") });
  });

  it("is cleared when the schedule changes", () => {
    const h = harness();
    const routine = h.daily();
    h.skip(routine.id, NINE + DAY);
    h.manager.update(routine.id, { name: "Renamed" });
    expect(h.manager.listRoutines()[0].skippedOccurrences).toEqual([NINE + DAY]);
    h.manager.update(routine.id, { schedule: { type: "daily", time: "10:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(h.manager.listRoutines()[0].skippedOccurrences).toBeUndefined();
  });

  it("survives a save and a reload, and reaches the client event", () => {
    const h = harness();
    const routine = h.daily();
    h.skip(routine.id, NINE + DAY);
    expect(h.emitted.filter((event) => event.kind === "routine").at(-1)?.routine).toMatchObject({ skippedOccurrences: [NINE + DAY] });
    expect(new RoutineManager(h.options as never).listRoutines()[0]).toMatchObject({ skippedOccurrences: [NINE + DAY], nextRunAt: NINE });
  });
});
