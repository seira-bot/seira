import type { WorkflowRun } from "../../../shared/workflows";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { reducedMotion } from "@/lib/onboarding";
import { stepOrder, stepTitle } from "@/lib/workflow-graph";
import { stepStatusText, stepViews, type StepState } from "@/lib/workflow-run";
import { StatusMark } from "./WorkflowStepCard";

const FOLD_FROM = 7;
const ALWAYS_SHOWN = 3;
const IN_VIEW: readonly StepState[] = ["failed", "running", "waiting"];

export function WorkflowRunSteps({ run, botName, onOpen }: {
  run: WorkflowRun;
  botName: (botId: string) => string | undefined;
  onOpen: () => void;
}) {
  const reduced = reducedMotion();
  const views = stepViews(run);
  const steps = stepOrder(run.graph);
  const rows = steps.map((step, index) => ({ step, view: views[step.id], index }));
  const folded = steps.length >= FOLD_FROM;
  const shown = folded ? rows.filter(({ view, index }) => index < ALWAYS_SHOWN || (view && IN_VIEW.includes(view.state))) : rows;
  const hidden = folded ? rows.filter((row) => !shown.includes(row)) : [];

  const list = (items: typeof rows) => (
    <ol className="space-y-1">
      {items.map(({ step, view }) => view && (
        <li key={step.id} data-step-status={view.state} className="flex items-start gap-2 text-[13px] leading-[18px]">
          <span className="mt-px flex"><StatusMark state={view.state} reduced={reduced} /></span>
          <span className="min-w-0 flex-1 truncate text-ink" dir="auto">{stepTitle(step, botName)}</span>
          <span className={cn("shrink-0", view.state === "failed" ? "text-danger" : "text-ink-secondary")}>{stepStatusText(view, step, botName)}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <div data-workflow-run={run.runId} className="space-y-2">
      {list(shown)}
      {hidden.length > 0 && (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-ink-secondary hover:text-ink">{t(hidden.length === 1 ? "workflow.run.moreSteps.one" : "workflow.run.moreSteps.other", { count: hidden.length })}</summary>
          <div className="mt-1">{list(hidden)}</div>
        </details>
      )}
      <button type="button" onClick={onOpen} className="rounded-lg px-2 py-1 text-[13px] font-medium text-accent-text hover:bg-raised">{t("automations.panel.open")}</button>
    </div>
  );
}
