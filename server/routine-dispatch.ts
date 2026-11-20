import { composeExecutionPrompt, continuityCarry } from "./routine-execution.ts";
import { startPrompt, type RoutineFailureFacts } from "./routine-recovery.ts";
import type { Routine, RoutineManagerOptions, RoutineRun } from "./routines.ts";

export interface RoutineDispatchDeps {
  options: Pick<RoutineManagerOptions, "startGoal" | "startTurn" | "promptSaid">;
  routines: readonly Routine[];
  runs: readonly RoutineRun[];
  failThread: (threadId: string, message: string, facts?: RoutineFailureFacts) => void;
}

export async function startRoutineWork(deps: RoutineDispatchDeps, run: RoutineRun, threadId: string): Promise<void> {
  const { options, failThread } = deps;
  const prompt = run.prompt ?? deps.routines.find((r) => r.id === run.routineId)?.prompt;
  if (!prompt) {
    failThread(threadId, "The routine was deleted before it could start", { cause: "refused" });
    return;
  }
  const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
  if (run.target === "room-goal") {
    if (!options.startGoal) {
      failThread(threadId, "Room goal routines are unavailable");
      return;
    }
    await options.startGoal(
      run.groupId,
      threadId,
      prompt,
      run.botId,
      run.id,
      (message) => failThread(threadId, message, { cause: "refused" }),
    );
  } else {
    await options.startTurn(
      run.botId,
      threadId,
      startPrompt(run, prompt, composeExecutionPrompt({ id: run.routineId, name: run.routineName, trigger: triggerSource, runOn: run.runOn ?? "seira" }, prompt, run.attachments, continuityCarry(run, deps.routines, deps.runs)), (first) => options.promptSaid?.(threadId, first) === true),
      run.runOn ?? "seira",
      triggerSource,
      (message) => failThread(threadId, message, { cause: "refused" }), run.id,
    );
  }
}
