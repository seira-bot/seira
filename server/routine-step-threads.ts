import type { RoutineAccess } from "../shared/routines.ts";
import { cloneRun } from "./routine-clone.ts";
import type { RoutineRun } from "./routines.ts";

/** The chats a workflow run opened for its bot steps, each with the access its steps use there. */
export type StepThreads = Record<string, { access?: RoutineAccess }>;

const LIVE: ReadonlySet<string> = new Set(["running", "waiting"]);

export const ownsThread = (run: RoutineRun, threadId: string): boolean =>
  run.threadId === threadId || (run.stepThreads !== undefined && Object.hasOwn(run.stepThreads, threadId));

export const isLiveThread = (runs: readonly RoutineRun[], threadId: string): boolean =>
  runs.some((run) => ownsThread(run, threadId) && LIVE.has(run.status));

/** The live run that owns this chat, else the latest; its access is the one its steps use in this chat. */
export function runOfThread(runs: readonly RoutineRun[], threadId: string): RoutineRun | null {
  const run = runs.findLast((candidate) => ownsThread(candidate, threadId) && LIVE.has(candidate.status)) ?? runs.findLast((candidate) => ownsThread(candidate, threadId));
  if (!run) return null;
  const copy = cloneRun(run);
  const own = run.stepThreads?.[threadId];
  if (own?.access !== undefined) copy.access = own.access;
  return copy;
}

/** Access only grows stricter. Returns true when the run changed. */
export function bindThread(run: RoutineRun, threadId: string, access?: RoutineAccess): boolean {
  if (run.workflowId === undefined) return false;
  const threads = run.stepThreads ?? (run.stepThreads = {});
  const strict = access ?? run.access;
  if (threads[threadId] && (threads[threadId].access !== undefined || strict === undefined)) return false;
  threads[threadId] = strict === undefined ? {} : { access: strict };
  return true;
}
