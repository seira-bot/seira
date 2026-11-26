import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { RoutineManager, type RoutineInput } from "./routines.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const START = Date.UTC(2026, 10, 25, 6, 0, 0);

const dirs: string[] = [];
const managers: RoutineManager[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function started(schedule: RoutineInput["schedule"], extra: Partial<RoutineInput> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seira-routine-clock-back-"));
  dirs.push(dir);
  let tasks = 0;
  const turns: string[] = [];
  let begun = 0;
  const manager = new RoutineManager({
    file: join(dir, "routines.json"),
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++tasks}` }),
    startTurn: async (_botId, threadId) => { turns.push(threadId); begun += 1; },
    skipStartupRuns: true,
  });
  managers.push(manager);
  const routine = manager.create({ name: "Clock check", prompt: "Check the clock", botId: "seira-1", schedule, ...extra });
  manager.start();
  // A routine does not start again while its last run is open, so each turn is finished at once.
  const finish = () => {
    for (const threadId of turns.splice(0)) {
      manager.handleRuntimeEvent({ eventId: `done-${threadId}`, provider: "fake", threadId, createdAt: new Date().toISOString(), type: "turn.completed", ok: true } as RuntimeEvent);
    }
  };
  return { manager, id: routine.id, turns, finish, count: () => begun, next: () => manager.listRoutines().find((candidate) => candidate.id === routine.id)!.nextRunAt };
}

describe("a clock that goes back after it ran ahead", () => {
  it.each<[string, RoutineInput["schedule"], number]>([
    ["cron", { type: "cron", expression: "* * * * *", timeZone: "UTC" }, MINUTE],
    ["interval", { type: "interval", everyMinutes: 5, anchorAt: START }, 5 * MINUTE],
  ])("sets a %s routine's next run from the clock that came back", async (_name, schedule, step) => {
    const { finish, count, next } = started(schedule);
    const runCount = () => { finish(); return count(); };
    await vi.advanceTimersByTimeAsync(step + 10_000);
    expect(runCount()).toBeGreaterThan(0);
    expect(next()).toBeLessThanOrEqual(Date.now() + step);

    // The clock jumps 30 days ahead: the routine moves its next run along with it.
    vi.setSystemTime(Date.now() + 30 * DAY);
    await vi.advanceTimersByTimeAsync(step + 10_000);
    runCount();
    expect(next()).toBeGreaterThan(START + 29 * DAY);

    // The clock is set right again: the next run must follow it, and runs must start again.
    vi.setSystemTime(Date.now() - 30 * DAY);
    await vi.advanceTimersByTimeAsync(MINUTE + 10_000);
    expect(next()).toBeLessThanOrEqual(Date.now() + step);
    const afterBack = runCount();
    await vi.advanceTimersByTimeAsync(2 * step);
    expect(runCount()).toBeGreaterThan(afterBack);
  });

  it("keeps a next run that was set later on purpose when the clock only moves a little", async () => {
    const { manager, id, next } = started({ type: "cron", expression: "* * * * *", timeZone: "UTC" });
    const until = Date.now() + 3 * 60 * MINUTE;
    manager.deferNextRun(id, until);
    vi.setSystemTime(Date.now() - 30_000); // an NTP step, below the limit
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(next()).toBe(until);
  });

  it("keeps the instant of a one-time run", async () => {
    const at = START + 10 * DAY;
    const { next } = started({ type: "once", at });
    vi.setSystemTime(START + 30 * DAY);
    vi.setSystemTime(START);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(next()).toBe(at);
  });
});
