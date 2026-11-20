import { useCallback, useEffect } from "react";

import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { loadWorkflowRun, loadWorkflowRuns, loadWorkflows, runsOf, useWorkflows } from "@/state/workflows";
import { WorkflowRunSteps } from "./WorkflowRunSteps";

export function WorkflowRoutineSection({ routineId, workflowId, runId }: { routineId: string; workflowId: string; runId?: string }) {
  const { state, dispatch } = useStore();
  const workflows = useWorkflows();
  const botName = useCallback((botId: string) => state.bots.find((bot) => bot.id === botId)?.name, [state.bots]);
  const workflow = workflows.workflows.find((candidate) => candidate.id === workflowId);
  const shownRunId = runId ?? runsOf(workflows, workflowId, routineId)[0]?.runId;
  const run = shownRunId ? workflows.details[shownRunId] : undefined;

  useEffect(() => {
    if (!runId) void loadWorkflowRuns(workflowId);
  }, [runId, workflowId]);
  useEffect(() => {
    if (shownRunId) void loadWorkflowRun(shownRunId).catch(() => {});
  }, [shownRunId]);

  if (!workflow && !workflows.loaded) return null;
  if (!workflow && workflows.failed && workflows.workflows.length === 0) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-[13px] leading-[18px] text-ink-secondary">
        <span className="min-w-0 flex-1">{t("workflow.loadFailed")}</span>
        <button type="button" onClick={() => void loadWorkflows()} className="ui-button">{t("common.tryAgain")}</button>
      </div>
    );
  }
  if (!workflow) return <p className="text-[13px] leading-[18px] text-ink-secondary">{t("workflow.routine.missing")}</p>;
  return (
    <section data-workflow-routine={routineId} className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[13px] font-medium leading-[18px] text-ink" dir="auto">{t("workflow.routine.runs", { name: workflow.name })}</p>
        <button type="button" onClick={() => dispatch({ type: "showRoutines", view: "workflows", workflowId })} className="shrink-0 rounded-lg px-2 py-1 text-[13px] text-accent-text hover:bg-raised">{t("workflow.routine.open")}</button>
      </div>
      {run && (
        <div>
          {!runId && <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-ink-tertiary">{t("workflow.routine.lastRun")}</p>}
          <WorkflowRunSteps run={run} botName={botName} onOpen={() => dispatch({ type: "showRoutines", view: "workflows", workflowId, workflowRunId: run.runId })} />
        </div>
      )}
    </section>
  );
}
