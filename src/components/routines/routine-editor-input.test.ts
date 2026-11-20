import { describe, expect, it } from "vitest";
import type { Routine, RoutineContextAttachment } from "@/lib/routines";
import { routineEditorInput, type RoutineEditorFields } from "./routine-editor-input";

const attachment = { path: "/tmp/notes.md" } as unknown as RoutineContextAttachment;

const fields = (over: Partial<RoutineEditorFields> = {}): RoutineEditorFields => ({
  name: "Morning digest",
  description: "Summarize the inbox",
  routineTarget: "bot",
  botId: "pepper",
  groupId: "group-1",
  runOn: "cloud" as RoutineEditorFields["runOn"],
  existingRoutine: undefined,
  savedAt: 1_000,
  schedule: { type: "daily", time: "09:00" } as unknown as RoutineEditorFields["schedule"],
  durationMinutes: 30,
  timeoutMinutes: null,
  overlap: "skip",
  continuity: true,
  recurrenceIsOnce: false,
  runOnStartup: true,
  attachments: [attachment],
  resultsThreadId: "thread-9",
  ...over,
});

describe("routineEditorInput", () => {
  it("keeps the bot fields and the results thread", () => {
    expect(routineEditorInput(fields())).toEqual({
      name: "Morning digest",
      prompt: "Summarize the inbox",
      target: "bot",
      botId: "pepper",
      groupId: null,
      runOn: "cloud",
      enabled: true,
      schedule: { type: "daily", time: "09:00" },
      durationMinutes: 30,
      timeoutMinutes: null,
      overlap: "skip",
      continuity: true,
      runOnStartup: true,
      attachments: [attachment],
      resultsThreadId: "thread-9",
    });
  });

  it("builds a room goal with the group, the maus location and no attachments", () => {
    const input = routineEditorInput(fields({ routineTarget: "room-goal" }));
    expect(input).toMatchObject({ target: "room-goal", groupId: "group-1", runOn: "maus", attachments: [], continuity: false });
    expect("resultsThreadId" in input).toBe(false);
  });

  it("drops the group of a room goal that has none", () => {
    expect(routineEditorInput(fields({ routineTarget: "room-goal", groupId: "" })).groupId).toBeNull();
  });

  it("turns continuity and run on startup off for a one-time schedule", () => {
    expect(routineEditorInput(fields({ recurrenceIsOnce: true }))).toMatchObject({ continuity: false, runOnStartup: false });
  });

  it("leaves enabled alone for a routine that is on", () => {
    const existing = { enabled: true, schedule: { type: "daily", time: "09:00" } } as unknown as Routine;
    expect(routineEditorInput(fields({ existingRoutine: existing })).enabled).toBeUndefined();
  });
});
