import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Workflow as WorkflowIcon } from "lucide-react";

import type { WorkflowRun } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { routineDateTime } from "@/lib/routine-display";
import { useShowThreads } from "@/lib/thread-preferences";
import { stepById, stepTitle } from "@/lib/workflow-graph";
import { activeRun, runStatusText, stepViews } from "@/lib/workflow-run";
import { ApiError } from "@/state/api";
import { useStore } from "@/state/store";
import { openThread } from "@/state/thread-navigation";
import { loadWorkflowRun, loadWorkflowRuns, runsOf, useWorkflows, workflowApi } from "@/state/workflows";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowRunPanel, type AgainState } from "./WorkflowRunPanel";
import { useDelayed } from "./useDelayed";

type Load = "loading" | "gone" | "failed" | "ready";

function firstSelected(run: WorkflowRun): string | null {
  const views = stepViews(run);
  const failed = run.graph.steps.find((step) => views[step.id]?.state === "failed");
  if (failed) return failed.id;
  if (run.currentStepId && stepById(run.graph, run.currentStepId)) return run.currentStepId;
  return stepById(run.graph, run.startStepId) ? run.startStepId : null;
}

function againErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t("workflow.run.againFailed");
  if (error.status === 403) return t("workflow.error.notAllowed");
  if (error.status === 409) return t("workflow.run.againConflict");
  if (error.status === 404) {
    const cause = typeof error.body?.error === "string" ? error.body.error : error.message;
    if (cause === "no such run") return t("workflow.run.gone");
    if (cause === "no such routine" || cause === "no such workflow") return t("workflow.run.againGone");
  }
  return t("workflow.run.againFailed");
}

const buttonClass = "ui-button ui-button-primary";

export function WorkflowRunView({ workflowId, runId, focusHeading, onAgainStarted }: {
  workflowId: string;
  runId: string;
  focusHeading: boolean;
  onAgainStarted: (newRunId: string, text: string) => void;
}) {
  const { state, dispatch } = useStore();
  const workflows = useWorkflows();
  const advanced = useAdvancedMode();
  const showThreads = useShowThreads();
  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [againError, setAgainError] = useState("");
  const chosen = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const botName = useCallback((botId: string) => state.bots.find((bot) => bot.id === botId)?.name, [state.bots]);
  const run = workflows.details[runId];
  const showSpinner = useDelayed(load === "loading" && !run);

  useEffect(() => {
    let current = true;
    setLoad("loading");
    loadWorkflowRun(runId, { force: attempt > 0 }).then(
      (loaded) => { if (current) setLoad(loaded ? "ready" : "gone"); },
      () => { if (current) setLoad("failed"); },
    );
    return () => { current = false; };
  }, [runId, attempt]);
  useEffect(() => { void loadWorkflowRuns(workflowId); }, [workflowId]);
  useEffect(() => {
    if (run && focusHeading) heading.current?.focus();
  }, [run, focusHeading]);
  useEffect(() => {
    if (!run || chosen.current) return;
    chosen.current = true;
    setSelectedId(firstSelected(run));
  }, [run]);

  const open = useCallback((id?: string) => dispatch({ type: "showRoutines", view: "workflows", workflowId: id }), [dispatch]);
  const views = useMemo(() => (run ? stepViews(run) : {}), [run]);
  const step = run && selectedId ? stepById(run.graph, selectedId) ?? null : null;
  const view = step ? views[step.id] : undefined;

  const again = ((): AgainState => {
    if (!run || !step || view?.state !== "failed" || run.status === "active") return { state: "hidden" };
    const routine = state.routines.find((candidate) => candidate.id === run.routineId);
    if (!routine) return { state: "hidden" };
    if (!routine.workflowId) return { state: "none" };
    if (routine.workflowId !== run.workflowId) return { state: "other" };
    const current = workflows.workflows.find((candidate) => candidate.id === run.workflowId);
    if (!current?.steps.some((candidate) => candidate.id === step.id)) return { state: "hidden" };
    return activeRun(state.routineRuns, routine.id) ? { state: "busy" } : { state: "show" };
  })();

  const runAgain = async (stepId: string) => {
    if (!run) return;
    setAgainError("");
    try {
      const started = await workflowApi.runAgain(run.runId, stepId);
      const target = stepById(run.graph, stepId);
      onAgainStarted(started.id, t("workflow.run.againStarted", { step: target ? stepTitle(target, botName) : "" }));
      dispatch({ type: "showRoutines", view: "workflows", workflowId: run.workflowId, workflowRunId: started.id });
    } catch (error) {
      setAgainError(againErrorText(error));
    }
  };

  if (load === "gone" || (load === "ready" && !run)) {
    const routineRun = state.routineRuns.find((candidate) => candidate.id === runId);
    const chatBotId = state.routines.find((candidate) => candidate.id === routineRun?.routineId)?.botId;
    const chatThreadId = routineRun?.threadId;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p role="status" className="text-[13px] text-ink-secondary">{t("workflow.run.gone")}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {chatBotId && chatThreadId && <button type="button" onClick={() => openThread(dispatch, { botId: chatBotId, threadId: chatThreadId }, state, showThreads)} className={buttonClass}>{t("workflow.result.openChat")}</button>}
          <button type="button" onClick={() => open()} className={buttonClass}>{t("workflow.all")}</button>
        </div>
      </div>
    );
  }
  if (load === "failed" && !run) {
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13px] text-ink-secondary">{t("workflow.run.loadFailed")}</p>
        <button type="button" onClick={() => setAttempt((count) => count + 1)} className={buttonClass}>{t("common.tryAgain")}</button>
      </div>
    );
  }
  if (!run) return <div className="flex flex-1 items-center justify-center">{showSpinner && <Loader2 size={20} aria-hidden className="animate-spin text-ink-tertiary motion-reduce:animate-none" />}</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline/35 px-4 py-2.5">
        <button type="button" onClick={() => open()} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus">
          <ArrowLeft size={15} aria-hidden />{t("workflow.all")}
        </button>
        <WorkflowIcon size={16} aria-hidden className="shrink-0 text-ink-tertiary" />
        <h2 ref={heading} tabIndex={-1} className="min-w-0 truncate text-[15px] font-semibold text-ink outline-none" dir="auto">{run.workflowName}</h2>
        <span className="text-[12px] text-ink-secondary">{t("workflow.run.started", { when: routineDateTime(run.createdAt) })}</span>
        <p role="status" data-workflow-run-status={run.status} className="min-w-0 flex-1 text-[13px] text-ink-secondary">{runStatusText(run, run.graph, botName)}</p>
        <button type="button" onClick={() => open(run.workflowId)} className="h-8 rounded-lg border border-hairline/50 px-3 text-[13px] text-ink hover:bg-raised">{t("workflow.run.edit")}</button>
      </div>
      {againError && <p role="alert" className="shrink-0 px-4 pt-2 text-[13px] text-danger">{againError}</p>}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative flex min-h-[320px] min-w-0 flex-1 flex-col">
          <WorkflowCanvas graph={run.graph} botName={botName} selectedId={selectedId} onSelect={setSelectedId} label={t("workflow.region")} statuses={views} />
        </div>
        <WorkflowRunPanel run={run} step={step} view={view} botName={botName} advanced={advanced} again={again} onRunAgain={runAgain}
          onOpenChat={(botId, threadId) => { openThread(dispatch, { botId, threadId }, state, showThreads); }}
          runs={runsOf(workflows, run.workflowId, run.routineId)} onOpenRun={(id) => dispatch({ type: "showRoutines", view: "workflows", workflowId: run.workflowId, workflowRunId: id })} />
      </div>
    </div>
  );
}
