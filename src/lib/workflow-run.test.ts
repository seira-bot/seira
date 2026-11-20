import { describe, expect, it } from "vitest";

import type { WorkflowRun, WorkflowStep, WorkflowStepErrorCode, WorkflowStepRun } from "../../shared/workflows";
import { WORKFLOW_RUN_LIMIT_MINUTES } from "../../shared/workflows";
import { routineDateTime } from "@/lib/routine-display";
import {
  activeRun,
  runStatusText,
  STEP_ERROR_TEXT,
  stepErrorText,
  stepStatusText,
  stepTook,
  stepViews,
  type StepView,
} from "./workflow-run";

const at = { x: 0, y: 0 };
const names: Record<string, string> = { ana: "Ana" };
const botName = (id: string) => names[id];
const bot: WorkflowStep = { id: "a", kind: "bot", botId: "ana", instruction: "Do it", position: at };
const check: WorkflowStep = { id: "c", kind: "check", question: "Is it ok?", position: at };
const note: WorkflowStep = { id: "n", kind: "note", text: "memo", position: at };
const post: WorkflowStep = { id: "p", kind: "post", position: at };
const graph = {
  steps: [bot, check, note, post],
  connections: [{ id: "1", from: "a", to: "c" }, { id: "2", from: "c", to: "p", branch: "yes" as const }],
};
const run = (patch: Partial<WorkflowRun> = {}): WorkflowRun => ({
  runId: "r1", workflowId: "w1", routineId: "rt1", workflowName: "Morning", status: "active", graph, botIds: ["ana"],
  startStepId: "a", threads: {}, stepRuns: [], createdAt: 1, updatedAt: 2, ...patch,
});
const stepRun = (patch: Partial<WorkflowStepRun> & { stepId: string }): WorkflowStepRun => ({ status: "done", ...patch });
const view = (state: StepView["state"], extra: Partial<WorkflowStepRun> = {}): StepView => ({ state, run: stepRun({ stepId: "a", ...extra }) });

describe("workflow run text", () => {
  it("shows Not started for a step without a record while the run works, and Didn't run after it ends", () => {
    const working = stepViews(run({ stepRuns: [stepRun({ stepId: "a" })] }));
    expect(Object.keys(working)).toEqual(["a", "c", "p"]);
    expect(working.a?.state).toBe("done");
    expect(working.c?.state).toBe("not_started");
    expect(stepStatusText(working.c!, check, botName)).toBe("Not started");
    const ended = stepViews(run({ status: "failed", stepRuns: [stepRun({ stepId: "a", status: "failed" })] }));
    expect(ended.c?.state).toBe("not_run");
    expect(stepStatusText(ended.c!, check, botName)).toBe("Didn't run");
    expect(stepStatusText(ended.a!, bot, botName)).toBe("Failed");
  });

  it("shows a carried step as done in an earlier run", () => {
    const views = stepViews(run({ stepRuns: [stepRun({ stepId: "a", carried: true })] }));
    expect(views.a?.state).toBe("carried");
    expect(stepStatusText(views.a!, bot, botName)).toBe("Done in an earlier run");
  });

  it("says what a waiting step waits for: a time, a busy bot, or your answer", () => {
    const resumeAt = new Date(2026, 10, 20, 9, 30).getTime();
    expect(stepStatusText(view("waiting", { status: "waiting", waitingFor: "time", resumeAt }), bot, botName)).toBe(`Waits until ${routineDateTime(resumeAt)}`);
    expect(stepStatusText(view("waiting", { status: "waiting", waitingFor: "bot", botId: "ana" }), bot, botName)).toBe("Waits for Ana to be free");
    expect(stepStatusText(view("waiting", { status: "waiting", waitingFor: "bot" }), bot, botName)).toBe("Waits for Ana to be free");
    expect(stepStatusText(view("waiting", { status: "waiting", waitingFor: "person" }), bot, botName)).toBe("Waits for your answer");
    expect(stepStatusText(view("running", { status: "running" }), bot, botName)).toBe("Working…");
    expect(stepStatusText(view("skipped", { status: "skipped" }), bot, botName)).toBe("Not taken");
  });

  it("shows the answer of a check", () => {
    expect(stepStatusText(view("done", { stepId: "c", answer: "yes" }), check, botName)).toBe("Answered yes");
    expect(stepStatusText(view("done", { stepId: "c", answer: "no" }), check, botName)).toBe("Answered no");
    expect(stepStatusText(view("done", { stepId: "c" }), check, botName)).toBe("Done");
    expect(stepStatusText(view("done", { answer: "yes" }), bot, botName)).toBe("Done");
  });

  it("words each run status, with the title of the failed step", () => {
    const failed = run({ status: "failed", stepRuns: [stepRun({ stepId: "a" }), stepRun({ stepId: "c", status: "failed" })] });
    expect(runStatusText(failed, graph, botName)).toBe("Failed at Is it ok?");
    expect(runStatusText(failed, undefined, botName)).toBe("Failed");
    expect(runStatusText(run({ status: "active", currentStepId: "a" }), graph, botName)).toBe("Working on Ana…");
    expect(runStatusText(run({ status: "active", currentStepId: "a" }), undefined, botName)).toBe("Working…");
    expect(runStatusText(run({ status: "active" }), graph, botName)).toBe("Working…");
    expect(runStatusText(run({ status: "completed" }), graph, botName)).toBe("Done");
    expect(runStatusText(run({ status: "stopped" }), graph, botName)).toBe("Stopped");
  });

  it("uses the step error text for a known code and the server text otherwise", () => {
    expect(stepErrorText(stepRun({ stepId: "a", status: "failed", errorCode: "turn_failed", botId: "ana", error: "raw" }), botName))
      .toBe("Ana couldn't finish this step. Open the chat to see why.");
    expect(stepErrorText(stepRun({ stepId: "a", status: "failed", errorCode: "run_limit", error: "raw" }), botName))
      .toBe(`The run reached its limit of ${WORKFLOW_RUN_LIMIT_MINUTES / 60} hours.`);
    expect(stepErrorText(stepRun({ stepId: "a", status: "failed", error: "raw" }), botName)).toBe("raw");
    expect(stepErrorText(stepRun({ stepId: "a", status: "failed" }), botName)).toBe("");
    expect(stepErrorText(stepRun({ stepId: "a", status: "failed", errorCode: "gone" as WorkflowStepErrorCode, error: "raw" }), botName)).toBe("raw");
  });

  it("gives every step error code an English text with its values filled", () => {
    for (const code of Object.keys(STEP_ERROR_TEXT) as WorkflowStepErrorCode[]) {
      const text = stepErrorText(stepRun({ stepId: "a", status: "failed", errorCode: code, botId: "ana" }), botName);
      expect(text, code).not.toMatch(/\{\w+\}/);
      expect(text).not.toBe("");
    }
  });

  it("times a finished step", () => {
    expect(stepTook(stepRun({ stepId: "a", startedAt: 0, finishedAt: 5 * 60_000 }))).toBe("5 min");
    expect(stepTook(stepRun({ stepId: "a", startedAt: 0, finishedAt: 1_000 }))).toBe("1 min");
    expect(stepTook(stepRun({ stepId: "a", startedAt: 0 }))).toBeNull();
  });

  it("finds an active run of a routine", () => {
    const runs = [{ status: "completed", routineId: "rt1" }, { status: "waiting", routineId: "rt2" }];
    expect(activeRun(runs, "rt1")).toBe(false);
    expect(activeRun(runs, "rt2")).toBe(true);
    expect(activeRun([...runs, { status: "queued", routineId: "rt1" }], "rt1")).toBe(true);
    expect(activeRun([{ status: "running", routineId: "rt1" }], "rt1")).toBe(true);
    expect(activeRun([], "rt1")).toBe(false);
  });
});
