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

const STRICTNESS: Record<RoutineAccess, number> = { "read-and-draft": 1 };

const accessIn = (run: RoutineRun, threadId: string): RoutineAccess | undefined => run.stepThreads?.[threadId]?.access ?? run.access;

/** The live run that owns this chat, else the latest. Security: its access is the strictest one that a live run uses in this
 *  chat, so when runs share a chat, no run's wider access applies to another run's turns. */
export function runOfThread(runs: readonly RoutineRun[], threadId: string): RoutineRun | null {
  const owners = runs.filter((candidate) => ownsThread(candidate, threadId));
  const live = owners.filter((candidate) => LIVE.has(candidate.status));
  const run = live.at(-1) ?? owners.at(-1);
  if (!run) return null;
  const copy = cloneRun(run);
  const access = [run, ...live].map((owner) => accessIn(owner, threadId))
    .reduce<RoutineAccess | undefined>((strictest, next) => (next !== undefined && (strictest === undefined || STRICTNESS[next] > STRICTNESS[strictest]) ? next : strictest), undefined);
  if (access !== undefined) copy.access = access;
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
