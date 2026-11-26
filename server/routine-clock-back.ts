// A clock that ran ahead and was then set right: the next runs it set stay far in the future (seira#569).
import { DUE_CLOCK_MS } from "./due-timer.ts";
import { nextOccurrence } from "./routine-schedules.ts";
import type { Routine } from "./routines.ts";

/** A wall clock that goes back by more than this between two looks is a clock that was set right, not a small correction. */
const CLOCK_BACK_MS = 2 * DUE_CLOCK_MS;
export const clockWentBack = (now: number, seen: number): boolean => now < seen - CLOCK_BACK_MS;

/** Each enabled daily, cron or interval routine whose next run is later than its first time after `now` takes that time.
 * A one-time run and a limit-reset run keep their instant. Returns the routines that moved. */
export function pullBackNextRuns(routines: readonly Routine[], now: number): Routine[] {
  return routines.filter((routine) => {
    const repeats = routine.schedule.type === "daily" || routine.schedule.type === "cron" || routine.schedule.type === "interval";
    if (!routine.enabled || !repeats || routine.nextRunAt == null || routine.nextRunAt <= now) return false;
    const next = nextOccurrence(routine.schedule, now);
    if (next === null || next >= routine.nextRunAt) return false;
    routine.nextRunAt = next;
    return true;
  });
}
