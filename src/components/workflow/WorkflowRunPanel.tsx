import { useState } from "react";

import type { WorkflowRun, WorkflowRunUpdate, WorkflowStep } from "../../../shared/workflows";
import { lastWhen } from "@/lib/automations";
import { t } from "@/lib/i18n";
import { stepTitle } from "@/lib/workflow-graph";
import { runStatusText, stepErrorText, stepStatusText, stepTook, type StepView } from "@/lib/workflow-run";
import { loadWorkflowRun } from "@/state/workflows";

const SIMPLE_OUTPUT_CHARS = 300;
const MAX_RUNS = 10;

export type AgainState = { state: "show" } | { state: "busy" } | { state: "other" } | { state: "none" } | { state: "hidden" };

const AGAIN_REASON_ID = "workflow-again-reason";
const keepShortResult = (): void => undefined;

export function WorkflowRunPanel({ run, step, view, botName, advanced, again, onRunAgain, onOpenChat, runs, onOpenRun }: {
  run: WorkflowRun;
  step: WorkflowStep | null;
  view: StepView | undefined;
  botName: (botId: string) => string | undefined;
  advanced: boolean;
  again: AgainState;
  onRunAgain: (stepId: string) => Promise<void>;
  onOpenChat?: (botId: string, threadId: string) => void;
  runs: WorkflowRunUpdate[];
  onOpenRun: (runId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const [reloaded, setReloaded] = useState<string[]>([]);
  const stepRun = view?.run;
  const output = stepRun?.output ?? "";
  const shownOutput = advanced || output.length <= SIMPLE_OUTPUT_CHARS ? output : `${output.slice(0, SIMPLE_OUTPUT_CHARS)}…`;
  const took = advanced && stepRun ? stepTook(stepRun) : null;
  const errorText = stepRun?.status === "failed" ? stepErrorText(stepRun, botName) : "";
  const threadId = stepRun?.threadId;
  const chatBot = stepRun?.botId ?? (step?.kind === "bot" ? step.botId : "");

  const runAgain = async () => {
    if (!step || pending) return;
    setPending(true);
    try {
      await onRunAgain(step.id);
    } finally {
      setPending(false);
    }
  };
  const reloadKey = `${run.runId}:${step?.id}`;
  const showFull = async () => {
    setLoadingFull(true);
    try {
      await loadWorkflowRun(run.runId, { force: true });
      setReloaded((keys) => [...keys, reloadKey]);
    } catch {
      keepShortResult();
    } finally {
      setLoadingFull(false);
    }
  };
  const recent = runs.slice(0, MAX_RUNS);

  return (
    <aside aria-label={t("workflow.result.title")} className="flex min-h-0 w-full flex-col gap-4 overflow-y-auto border-t border-hairline/40 bg-app p-4 text-[13px] lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0">
      {step && view && (
        <section data-workflow-result={step.id} className="space-y-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink-tertiary">{t("workflow.result.title")}</h3>
          <p className="font-medium text-ink" dir="auto">{stepTitle(step, botName)}</p>
          <p className="text-ink-secondary">{stepStatusText(view, step, botName)}</p>
          {took && <p className="text-ink-secondary">{t("workflow.result.took", { duration: took })}</p>}
          {errorText && <p className="text-danger" dir="auto">{errorText}</p>}
          {output ? (
            <p className="whitespace-pre-wrap break-words rounded-lg bg-inset p-2.5 text-ink" dir="auto">{shownOutput}</p>
          ) : (
            <p className="text-ink-secondary">{t("workflow.result.none")}</p>
          )}
          {advanced && stepRun?.outputClipped && (reloaded.includes(reloadKey)
            ? <p className="text-ink-secondary">{t("workflow.result.inChat")}</p>
            : <button type="button" disabled={loadingFull} onClick={() => void showFull()} className="ui-button">{t("workflow.result.full")}</button>)}
          {advanced && stepRun?.error && (
            <details className="text-ink-secondary">
              <summary className="cursor-pointer hover:text-ink">{t("workflow.result.details")}</summary>
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px]">{stepRun.error}</p>
            </details>
          )}
          {threadId && onOpenChat && (
            <button type="button" onClick={() => onOpenChat(chatBot, threadId)} className="ui-button">{t("workflow.result.openChat")}</button>
          )}
          {again.state === "show" && (
            <button type="button" disabled={pending} onClick={() => void runAgain()} className="ui-button ui-button-primary">{t("workflow.run.again")}</button>
          )}
          {again.state === "busy" && (
            <div className="space-y-1">
              <button type="button" aria-disabled="true" aria-describedby={AGAIN_REASON_ID} className="ui-button ui-button-primary cursor-not-allowed opacity-50">{t("workflow.run.again")}</button>
              <p id={AGAIN_REASON_ID} className="text-ink-secondary">{t("workflow.run.againBusy")}</p>
            </div>
          )}
          {again.state === "none" && <p className="text-ink-secondary">{t("workflow.run.noWorkflow")}</p>}
          {again.state === "other" && <p className="text-ink-secondary">{t("workflow.run.otherWorkflow")}</p>}
        </section>
      )}
      {recent.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink-tertiary">{t("workflow.run.runs")}</h3>
          <ul className="space-y-0.5">
            {recent.map((candidate) => (
              <li key={candidate.runId}>
                <button type="button" aria-current={candidate.runId === run.runId ? "true" : undefined} onClick={() => onOpenRun(candidate.runId)}
                  className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised aria-[current=true]:bg-raised">
                  <span className="shrink-0 text-ink-secondary">{lastWhen(candidate.createdAt)}</span>
                  <span className="min-w-0 truncate text-ink">{candidate.runId === run.runId ? runStatusText(run, run.graph, botName) : runStatusText(candidate, undefined, botName)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
