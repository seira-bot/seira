import { isDone } from "@/lib/automations";
import type { Routine, RoutineContextAttachment, RoutineInput, RoutineRunOn, RoutineTarget } from "@/lib/routines";

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
}

export function routineEditorInput(fields: RoutineEditorFields): RoutineInput {
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
  };
}
