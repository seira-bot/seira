import type { RequestAuth } from "../request-auth.ts";
import type { Routine } from "../routines.ts";

export const WORKFLOW_ROUTINE_REFUSAL = "This workflow runs a routine you can't change.";

export interface WorkflowRoutineEdits {
  /** Why this person may not change this routine; null when they may. */
  refusal(auth: RequestAuth, routine: Routine): string | null;
  /** Who a save by this person is recorded under. */
  writer(auth: RequestAuth): string;
  /** Runs a workflow change as this person's rewrite of these routines, then settles who wrote them. */
  edit<T>(auth: RequestAuth, routines: readonly Routine[], change: () => T): T;
}

export interface WorkflowRoutineEditsDeps {
  /** The refusal that saving the routine as this person meets: what they see, and where they may point it. */
  refusal(auth: RequestAuth, routine: Routine): string | null;
  /** Who a rewrite by this person is recorded under (the routine save's writer). */
  writer(auth: RequestAuth): string;
  withWriter<T>(writer: string, work: () => T): T;
  current(id: string): Routine | undefined;
  /** The same follow-up as the routine save: the Cloud author record and the phones' owner record. */
  edited(auth: RequestAuth, routine: Routine, writer: string): void;
}

export function createWorkflowRoutineEdits(deps: WorkflowRoutineEditsDeps): WorkflowRoutineEdits {
  return {
    writer: (auth) => deps.writer(auth),
    refusal: (auth, routine) => (deps.refusal(auth, routine) === null ? null : WORKFLOW_ROUTINE_REFUSAL),
    edit(auth, routines, change) {
      const writer = deps.writer(auth);
      const result = deps.withWriter(writer, change);
      for (const routine of routines) {
        const now = deps.current(routine.id);
        if (now) deps.edited(auth, now, writer);
      }
      return result;
    },
  };
}
