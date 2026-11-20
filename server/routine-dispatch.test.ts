import { describe, expect, it, vi } from "vitest";
import { startRoutineWork, type RoutineDispatchDeps } from "./routine-dispatch.ts";
import type { RoutineRun } from "./routines.ts";

const deps = (over: Partial<RoutineDispatchDeps["options"]> = {}) => ({
  options: { startTurn: vi.fn(async () => {}), ...over },
  routines: [],
  runs: [],
  failThread: vi.fn(),
}) satisfies RoutineDispatchDeps;

const run = (over: Partial<RoutineRun> = {}) => ({ id: "run-1", routineId: "r-1", routineName: "Digest", botId: "pepper", target: "bot", ...over }) as RoutineRun;

describe("startRoutineWork", () => {
  it("fails the thread when the routine has no prompt", async () => {
    const d = deps();
    await startRoutineWork(d, run(), "thread-1");
    expect(d.failThread).toHaveBeenCalledWith("thread-1", "The routine was deleted before it could start", { cause: "refused" });
    expect(d.options.startTurn).not.toHaveBeenCalled();
  });

  it("fails a room goal when goals are unavailable", async () => {
    const d = deps();
    await startRoutineWork(d, run({ target: "room-goal", prompt: "Plan" }), "thread-1");
    expect(d.failThread).toHaveBeenCalledWith("thread-1", "Room goal routines are unavailable");
  });

  it("starts a room goal with the run prompt", async () => {
    const startGoal = vi.fn(async () => {});
    await startRoutineWork(deps({ startGoal }), run({ target: "room-goal", prompt: "Plan", groupId: "g1" }), "thread-1");
    expect(startGoal).toHaveBeenCalledWith("g1", "thread-1", "Plan", "pepper", "run-1", expect.any(Function));
  });

  it("starts a bot turn in the seira location by default", async () => {
    const d = deps();
    await startRoutineWork(d, run({ prompt: "Do it" }), "thread-1");
    expect(d.options.startTurn).toHaveBeenCalledWith("pepper", "thread-1", expect.stringContaining("Do it"), "seira", "schedule", expect.any(Function), "run-1");
  });
});
