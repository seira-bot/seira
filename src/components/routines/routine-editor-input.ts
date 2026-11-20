import { isDone } from "@/lib/automations";
import type { Routine, RoutineContextAttachment, RoutineInput, RoutineRunOn, RoutineTarget } from "@/lib/routines";

export type WorkflowBlock = "room" | "cloud" | "limit";

export type WorkflowChoice = { mode: "instructions" } | { mode: "workflow"; id: string | null };

export function choiceOf(workflowId: string | null): WorkflowChoice {
  return workflowId === null ? { mode: "instructions" } : { mode: "workflow", id: workflowId || null };
}

export function workflowIdOf(choice: WorkflowChoice): string | null {
  return choice.mode === "instructions" ? null : choice.id ?? "";
}

export function workflowBlock(fields: { target: RoutineTarget; runOn: RoutineRunOn; limitReset: boolean }): WorkflowBlock | null {
  if (fields.target === "room-goal") return "room";
  if (fields.runOn === "cloud") return "cloud";
  if (fields.limitReset) return "limit";
  return null;
}

export function workflowClears(routine: Routine | undefined): boolean {
  return Boolean(routine && !routine.workflowId && (routine.deliver || routine.modelSelection || routine.checks?.length || routine.access === "read-and-draft"));
}

export interface RoutineEditorFields {
  name: string;
  description: string;
  routineTarget: RoutineTarget;
  botId: string;
  groupId: string;
  runOn: RoutineRunOn;
  existingRoutine: Routine | undefined;
  savedAt: number;
  schedule: RoutineInput["schedule"];
  durationMinutes: number;
  timeoutMinutes: RoutineInput["timeoutMinutes"];
  overlap: RoutineInput["overlap"];
  continuity: boolean;
  recurrenceIsOnce: boolean;
  runOnStartup: boolean;
  attachments: RoutineContextAttachment[];
  resultsThreadId: string | null | undefined;
  workflowId?: string | null;
}

function workflowFields(fields: RoutineEditorFields): Partial<RoutineInput> & { sameConversation?: boolean } {
  if (fields.workflowId) {
    return { workflowId: fields.workflowId, deliver: null, modelSelection: null, checks: null, access: null, sameConversation: false };
  }
  if (fields.workflowId === null && fields.existingRoutine?.workflowId) return { workflowId: null };
  return {};
}

export function routineEditorInput(fields: RoutineEditorFields): RoutineInput & { sameConversation?: boolean } {
  const { routineTarget, existingRoutine, savedAt } = fields;
  return {
    name: fields.name,
    prompt: fields.description,
    target: routineTarget,
    botId: fields.botId,
    groupId: routineTarget === "room-goal" && fields.groupId ? fields.groupId : null,
    runOn: routineTarget === "room-goal" ? "seira" : fields.runOn,
    enabled: existingRoutine && (existingRoutine.enabled || !isDone(existingRoutine, savedAt)) ? undefined : true,
    schedule: fields.schedule,
    durationMinutes: fields.durationMinutes,
    timeoutMinutes: fields.timeoutMinutes,
    overlap: fields.overlap,
    continuity: routineTarget === "bot" && !fields.recurrenceIsOnce && fields.continuity,
    runOnStartup: !fields.recurrenceIsOnce && fields.runOnStartup,
    attachments: routineTarget === "room-goal" ? [] : fields.attachments,
    ...(routineTarget === "bot" ? { resultsThreadId: fields.resultsThreadId } : {}),
    ...workflowFields(fields),
  };
}
