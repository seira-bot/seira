import {
  WORKFLOW_RUN_LIMIT_MINUTES,
  type WorkflowGraph,
  type WorkflowRun,
  type WorkflowRunUpdate,
  type WorkflowStep,
  type WorkflowStepErrorCode,
  type WorkflowStepRun,
  type WorkflowStepStatus,
} from "../../shared/workflows";
import { t } from "@/lib/i18n";
import { routineDateTime } from "@/lib/routine-display";
import { durationLabel } from "@/lib/schedule-label";
import { stepById, stepTitle } from "@/lib/workflow-graph";
import type { LocaleKey } from "@/locales";

export type StepState = WorkflowStepStatus | "not_started" | "carried";
export interface StepView { state: StepState; run?: WorkflowStepRun }

export const STEP_ERROR_TEXT: Record<WorkflowStepErrorCode, LocaleKey> = {
  bot_missing: "workflow.stepError.botMissing",
  bot_busy_too_long: "workflow.stepError.botBusy",
  turn_failed: "workflow.stepError.turnFailed",
  needs_person: "workflow.stepError.needsPerson",
  check_unclear: "workflow.stepError.checkUnclear",
  restart_cut: "workflow.stepError.restartCut",
  run_stopped: "workflow.stepError.runStopped",
  run_limit: "workflow.stepError.runLimit",
};

type BotName = (botId: string) => string | undefined;

/** One entry per step that can run; a note has none. */
export function stepViews(run: WorkflowRun): Record<string, StepView> {
  const views: Record<string, StepView> = {};
  for (const step of run.graph.steps) {
    if (step.kind === "note") continue;
    const stepRun = run.stepRuns.find((candidate) => candidate.stepId === step.id);
    views[step.id] = stepRun
      ? { state: stepRun.carried ? "carried" : stepRun.status, run: stepRun }
      : { state: run.status === "active" ? "not_started" : "not_run" };
  }
  return views;
}

export function stepStatusText(view: StepView, step: WorkflowStep, botName: BotName): string {
  const stepRun = view.run;
  switch (view.state) {
    case "not_started": return t("workflow.status.notStarted");
    case "waiting": {
      if (stepRun?.waitingFor === "time" && stepRun.resumeAt !== undefined) return t("workflow.status.waitTime", { time: routineDateTime(stepRun.resumeAt) });
      if (stepRun?.waitingFor === "bot") {
        const botId = stepRun.botId ?? (step.kind === "bot" ? step.botId : "");
        return t("workflow.status.waitBot", { bot: botName(botId) ?? t("workflow.step.noBot") });
      }
      if (stepRun?.waitingFor === "person") return t("workflow.status.waitPerson");
      return t("workflow.status.running");
    }
    case "running": return t("workflow.status.running");
    case "done":
      if (step.kind === "check" && stepRun?.answer) return t(stepRun.answer === "yes" ? "workflow.status.yes" : "workflow.status.no");
      return t("workflow.status.done");
    case "failed": return t("workflow.status.failed");
    case "skipped": return t("workflow.status.skipped");
    case "not_run": return t("workflow.status.notRun");
    case "carried": return t("workflow.status.carried");
  }
}

export function stepErrorText(stepRun: WorkflowStepRun, botName: BotName): string {
  const code = stepRun.errorCode;
  if (!code || !Object.hasOwn(STEP_ERROR_TEXT, code)) return stepRun.error ?? "";
  return t(STEP_ERROR_TEXT[code], {
    bot: (stepRun.botId ? botName(stepRun.botId) : undefined) ?? t("workflow.step.noBot"),
    hours: WORKFLOW_RUN_LIMIT_MINUTES / 60,
  });
}

export function runStatusText(run: WorkflowRunUpdate, graph: WorkflowGraph | undefined, botName: BotName): string {
  const title = (stepId: string | undefined): string | null => {
    const step = graph && stepId ? stepById(graph, stepId) : undefined;
    return step ? stepTitle(step, botName) : null;
  };
  switch (run.status) {
    case "active": {
      const step = title(run.currentStepId);
      return step ? t("workflow.run.workingOn", { step }) : t("workflow.run.status.active");
    }
    case "completed": return t("workflow.run.status.completed");
    case "failed": {
      const step = title(run.stepRuns.find((stepRun) => stepRun.status === "failed")?.stepId);
      return step ? t("workflow.run.status.failedAt", { step }) : t("workflow.run.status.failed");
    }
    case "stopped": return t("workflow.run.status.stopped");
  }
}

export function stepTook(stepRun: WorkflowStepRun): string | null {
  if (stepRun.startedAt === undefined || stepRun.finishedAt === undefined) return null;
  return durationLabel(Math.max(1, Math.round((stepRun.finishedAt - stepRun.startedAt) / 60_000)));
}

const ACTIVE_ROUTINE_RUN = new Set(["queued", "running", "waiting"]);

export function activeRun(runs: readonly { status: string; routineId: string }[], routineId: string): boolean {
  return runs.some((run) => run.routineId === routineId && ACTIVE_ROUTINE_RUN.has(run.status));
}

export function stepsWorkflowId(run: { workflowId?: string; status: string } | undefined): string | undefined {
  return run?.workflowId && run.status !== "queued" && run.status !== "missed" ? run.workflowId : undefined;
}
