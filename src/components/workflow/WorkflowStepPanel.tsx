import { useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";

import type { WorkflowBranch, WorkflowStep } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { newId, type DraftAction } from "@/lib/workflow-canvas";
import { connectRefusal, KIND_LABEL, outgoing, stepTitle, waitMinutes, waitParts, type WaitUnit } from "@/lib/workflow-graph";
import type { Bot } from "@/state/store";
import type { WorkflowDraft } from "@/state/workflows";
import { Select } from "../Select";

const FIELD = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] leading-[18px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus";
const LABEL = "text-[12px] font-medium leading-4 text-ink-secondary";
const HINT = "text-[12px] leading-4 text-ink-tertiary";
const UNITS: readonly WaitUnit[] = ["minutes", "hours", "days"];
const WAIT_MAX = 43_200;

export function WorkflowStepPanel({ draft, step, bots, botName, problem, dispatch, onRemove, onAnnounce }: {
  draft: WorkflowDraft;
  step: WorkflowStep | null;
  bots: Bot[];
  botName: (botId: string) => string | undefined;
  problem?: string;
  dispatch: (action: DraftAction) => void;
  onRemove: (stepId: string) => void;
  onAnnounce: (text: string) => void;
}) {
  if (!step) {
    return (
      <aside aria-label={t("workflow.panel.label")} className="flex w-full flex-col gap-4 p-4 text-[13px] text-ink-tertiary lg:w-80 lg:shrink-0">
        <p>{t("workflow.panel.empty")}</p>
      </aside>
    );
  }
  const change = (patch: Extract<DraftAction, { type: "change" }>["patch"]) => dispatch({ type: "change", stepId: step.id, patch });
  const waitBad = step.kind === "wait" && !(Number.isInteger(step.minutes) && step.minutes >= 1 && step.minutes <= WAIT_MAX);
  const shown = problem ?? (waitBad ? t("workflow.problem.waitRange") : undefined);

  return (
    <aside aria-label={t("workflow.panel.label")} className="flex min-h-0 w-full flex-col border-t border-hairline/40 bg-app lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <h2 className="text-[15px] font-semibold leading-6 text-ink">{t(KIND_LABEL[step.kind])}</h2>
        {shown && <p data-step-problem className="text-[13px] leading-[18px] text-warning">{shown}</p>}
        {step.kind === "bot" && (
          <>
            <Field label={t("workflow.panel.bot")} id={`${step.id}-bot`}>
              <Select id={`${step.id}-bot`} value={step.botId} onChange={(event) => change({ botId: event.target.value })}>
                <option value="">{t("workflow.panel.chooseBot")}</option>
                {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </Select>
            </Field>
            <Field label={t("workflow.panel.instruction")} id={`${step.id}-instruction`} hint={t("workflow.panel.instructionHint")}>
              <textarea id={`${step.id}-instruction`} rows={5} dir="auto" value={step.instruction} onChange={(event) => change({ instruction: event.target.value })} className={FIELD} />
            </Field>
          </>
        )}
        {step.kind === "check" && (
          <Field label={t("workflow.panel.question")} id={`${step.id}-question`} hint={t("workflow.panel.questionHint")}>
            <textarea id={`${step.id}-question`} rows={3} dir="auto" value={step.question} onChange={(event) => change({ question: event.target.value })} className={FIELD} />
          </Field>
        )}
        {step.kind === "wait" && <WaitFields key={step.id} step={step} onChange={(minutes) => change({ minutes })} />}
        {step.kind === "post" && <p className={HINT}>{t("workflow.panel.postHelp")}</p>}
        {step.kind === "note" && (
          <Field label={t("workflow.panel.noteText")} id={`${step.id}-note`}>
            <textarea id={`${step.id}-note`} rows={4} dir="auto" value={step.text} onChange={(event) => change({ text: event.target.value })} className={FIELD} />
          </Field>
        )}
        {step.kind === "check" ? (
          <>
            <Next draft={draft} step={step} branch="yes" label={t("workflow.panel.ifYes")} botName={botName} dispatch={dispatch} onAnnounce={onAnnounce} />
            <Next draft={draft} step={step} branch="no" label={t("workflow.panel.ifNo")} botName={botName} dispatch={dispatch} onAnnounce={onAnnounce} />
          </>
        ) : step.kind !== "note" && (
          <Next draft={draft} step={step} label={t("workflow.panel.then")} botName={botName} dispatch={dispatch} onAnnounce={onAnnounce} />
        )}
      </div>
      <div className="flex shrink-0 items-center border-t border-hairline/40 px-4 py-2">
        <button type="button" onClick={() => onRemove(step.id)} className="flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] text-danger outline-none hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-focus">
          <Trash2 size={15} aria-hidden />{t("workflow.panel.delete")}
        </button>
      </div>
    </aside>
  );
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  );
}

function WaitFields({ step, onChange }: { step: Extract<WorkflowStep, { kind: "wait" }>; onChange: (minutes: number) => void }) {
  const fromMinutes = (minutes: number) => ({ ...waitParts(minutes), amount: String(waitParts(minutes).amount), minutes });
  const [shown, setShown] = useState(() => fromMinutes(step.minutes));
  if (step.minutes !== shown.minutes) setShown(fromMinutes(step.minutes));
  const emptyId = `${step.id}-amount-problem`;
  const empty = shown.amount.trim() === "";
  const apply = (amount: string, unit: WaitUnit) => {
    const value = Number(amount);
    if (amount.trim() !== "" && Number.isFinite(value)) {
      const minutes = waitMinutes(value, unit);
      setShown({ amount, unit, minutes });
      onChange(minutes);
    } else setShown({ ...shown, amount, unit });
  };
  return (
    <>
      <div className="flex items-end gap-2">
        <Field label={t("workflow.panel.waitFor")} id={`${step.id}-amount`}>
          <input id={`${step.id}-amount`} type="number" min={1} inputMode="numeric" value={shown.amount} aria-invalid={empty || undefined} aria-describedby={empty ? emptyId : undefined}
            onChange={(event) => apply(event.target.value, shown.unit)} className={FIELD} />
        </Field>
        <Field label={t("workflow.panel.unit")} id={`${step.id}-unit`}>
          <Select id={`${step.id}-unit`} value={shown.unit} onChange={(event) => apply(shown.amount, event.target.value as WaitUnit)}>
            {UNITS.map((option) => <option key={option} value={option}>{t(`workflow.unit.${option}` as const)}</option>)}
          </Select>
        </Field>
      </div>
      {empty && <p id={emptyId} data-step-problem className="text-[13px] leading-[18px] text-warning">{t("workflow.problem.waitRange")}</p>}
    </>
  );
}

function Next({ draft, step, branch, label, botName, dispatch, onAnnounce }: {
  draft: WorkflowDraft;
  step: WorkflowStep;
  branch?: WorkflowBranch;
  label: string;
  botName: (botId: string) => string | undefined;
  dispatch: (action: DraftAction) => void;
  onAnnounce: (text: string) => void;
}) {
  const slot = outgoing(draft, step.id).find((connection) => (branch ? connection.branch === branch : true));
  const options = draft.steps.filter((other) => other.id === slot?.to || connectRefusal(draft, step.id, other.id, branch) === null);
  const id = `${step.id}-next-${branch ?? "then"}`;
  const pick = (to: string) => {
    if (to === "") {
      if (!slot) return;
      dispatch({ type: "disconnect", connectionId: slot.id });
      const target = draft.steps.find((other) => other.id === slot.to);
      if (target) onAnnounce(t("workflow.announce.disconnected", { from: stepTitle(step, botName), to: stepTitle(target, botName) }));
      return;
    }
    const target = draft.steps.find((other) => other.id === to);
    dispatch({ type: "connect", connection: { id: newId("c"), from: step.id, to, ...(branch ? { branch } : {}) } });
    if (target) onAnnounce(t("workflow.announce.connected", { from: stepTitle(step, botName), to: stepTitle(target, botName) }));
  };
  return (
    <Field label={label} id={id}>
      <Select id={id} value={slot?.to ?? ""} onChange={(event) => pick(event.target.value)}>
        <option value="">{t("workflow.panel.nothing")}</option>
        {options.map((other) => <option key={other.id} value={other.id}>{stepTitle(other, botName)}</option>)}
      </Select>
    </Field>
  );
}
