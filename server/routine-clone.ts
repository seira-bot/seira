import { cloneAttachments } from "./routine-attachments.ts";
import { cloneSchedule } from "./routine-schedules.ts";
import type { Routine, RoutineRun } from "./routines.ts";

export function cloneRoutine(routine: Routine): Routine {
  return {
    ...routine,
    schedule: cloneSchedule(routine.schedule),
    attachments: cloneAttachments(routine.attachments),
  };
}

export function cloneRun(run: RoutineRun): RoutineRun {
  return {
    ...run,
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
  };
}
