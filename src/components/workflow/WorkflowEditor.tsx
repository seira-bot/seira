import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, Trash2, Workflow as WorkflowIcon } from "lucide-react";

import type { Workflow, WorkflowStepKind } from "../../../shared/workflows";
import { listOf } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { freeSpot, newId, newStep, removalOf, STEP_HEIGHT, STEP_WIDTH, type Removal } from "@/lib/workflow-canvas";
import { problemText, readingOrder, runnableProblem, stepById, stepTitle, type ClientProblem } from "@/lib/workflow-graph";
import type { Point } from "@/lib/team-canvas";
import { useStore } from "@/state/store";
import { schedulableBots, useTeamPeople } from "@/state/team-people";
import type { WorkflowDraft } from "@/state/workflows";
import { UndoToast } from "../bot-access/ShareBotButton";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { routineLabel } from "./WorkflowList";
import { WorkflowPalette } from "./WorkflowPalette";
import { WorkflowStepPanel } from "./WorkflowStepPanel";
import { useWorkflowDraft, type SaveStatus } from "./useWorkflowDraft";

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function WorkflowEditor({ workflow, usedBy, onBack, onGone, onDelete, onUseInRoutine }: {
  workflow: Workflow;
  usedBy: Routine[];
  onBack: () => void;
  onGone: () => void;
  onDelete: (workflow: Workflow, draft: WorkflowDraft) => Promise<void>;
  onUseInRoutine?: (workflow: Workflow) => void;
}) {
  const { state } = useStore();
  const team = useTeamPeople();
  const botName = useCallback((botId: string) => state.bots.find((bot) => bot.id === botId)?.name, [state.bots]);
  const botExists = useCallback((botId: string) => state.bots.some((bot) => bot.id === botId), [state.bots]);
  const { draft, dispatch, status, problems, retry, reload, beginDelete, cancelDelete } = useWorkflowDraft(workflow, { botName, botExists, onGone });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [undo, setUndo] = useState<{ removal: Removal; text: string; key: number } | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ stepId: string | null } | null>(null);
  const reasonId = useId();
  const [deleteFailed, setDeleteFailed] = useState(false);
  const center = useRef<(() => Point) | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const undoKey = useRef(0);
  const selected = selectedId ? stepById(draft, selectedId) ?? null : null;
  const visibleBots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);

  const stepProblems = useMemo(() => {
    const byStep: Record<string, string> = {};
    const add = (problem: ClientProblem) => {
      if (problem.stepId && !Object.hasOwn(byStep, problem.stepId)) byStep[problem.stepId] = problemText(problem, draft, botName);
    };
    problems.forEach(add);
    const blocking = runnableProblem(draft, botExists);
    if (blocking) add(blocking);
    return byStep;
  }, [problems, draft, botName, botExists]);

  const runBlock = draft.steps.length > 0 || usedBy.length > 0 ? runnableProblem(draft, botExists) : null;
  const runBlockText = runBlock ? problemText(runBlock, draft, botName) : null;

  const removeStep = useCallback((stepId: string) => {
    const removal = removalOf(draft, stepId);
    if (!removal) return;
    const order = readingOrder(draft);
    const index = order.findIndex((step) => step.id === stepId);
    const neighbour = order[index + 1] ?? order[index - 1];
    dispatch({ type: "remove", stepId });
    setSelectedId((current) => current === stepId ? null : current);
    setFocusTarget({ stepId: neighbour?.id ?? null });
    setUndo({ removal, text: t("workflow.deletedStep", { step: stepTitle(removal.step, botName) }), key: ++undoKey.current });
  }, [draft, dispatch, botName]);

  const undoDone = useCallback(() => setUndo(null), []);
  const undoRemoval = useCallback(async () => {
    if (!undo) return;
    dispatch({ type: "restore", removal: undo.removal });
    setAnnouncement(t("workflow.announce.restored", { step: stepTitle(undo.removal.step, botName) }));
    setFocusTarget({ stepId: undo.removal.step.id });
  }, [undo, dispatch, botName]);

  useEffect(() => {
    if (!focusTarget) return;
    const selector = focusTarget.stepId === null ? "[data-workflow-canvas]" : `[data-workflow-step="${CSS.escape(focusTarget.stepId)}"]`;
    shell.current?.querySelector<HTMLElement>(selector)?.focus();
    setFocusTarget(null);
  }, [focusTarget, draft]);

  useEffect(() => {
    if (!undo) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z" || isTyping(event.target)) return;
      event.preventDefault();
      void undoRemoval().then(undoDone);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, undoRemoval, undoDone]);

  const defaultBot = (): string => {
    const lastBot = [...draft.steps].reverse().find((step) => step.kind === "bot");
    const chosen = selected?.kind === "bot" && selected.botId ? selected.botId : lastBot?.kind === "bot" ? lastBot.botId : "";
    return chosen || schedulableBots(visibleBots, team)[0]?.id || visibleBots[0]?.id || "";
  };

  const place = (kind: WorkflowStepKind, at: Point, after?: { stepId: string; connectionId: string }) => {
    const step = newStep(kind, freeSpot(draft.steps, at), kind === "bot" ? defaultBot() : undefined);
    dispatch({ type: "add", step, after });
    setSelectedId(step.id);
    setAnnouncement(t("workflow.announce.added", { step: stepTitle(step, botName) }));
  };
  const add = (kind: WorkflowStepKind) => {
    const from = selected && selected.kind !== "note" && kind !== "note" ? selected : null;
    const at = from
      ? { x: from.position.x + STEP_WIDTH / 2, y: from.position.y + STEP_HEIGHT * 1.5 + 24 }
      : center.current?.() ?? { x: 160, y: 120 };
    place(kind, at, from ? { stepId: from.id, connectionId: newId("c") } : undefined);
  };

  const deleteWorkflow = async () => {
    if (usedBy.length > 0) return;
    setDeleteFailed(false);
    const unsaved = beginDelete();
    try {
      await onDelete(workflow, unsaved);
    } catch {
      cancelDelete();
      setDeleteFailed(true);
    }
  };

  const panelBots = selected?.kind === "bot" ? schedulableBots(visibleBots, team, selected.botId) : schedulableBots(visibleBots, team);

  return (
    <div ref={shell} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline/35 px-4 py-2.5">
        <button type="button" onClick={onBack} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus">
          <ArrowLeft size={15} aria-hidden />{t("workflow.all")}
        </button>
        <WorkflowIcon size={16} aria-hidden className="shrink-0 text-ink-tertiary" />
        <input type="text" dir="auto" aria-label={t("workflow.nameLabel")} value={draft.name} onChange={(event) => dispatch({ type: "rename", name: event.target.value })}
          className="h-8 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-[15px] font-semibold text-ink outline-none hover:border-hairline/50 focus-visible:border-hairline focus-visible:ring-2 focus-visible:ring-focus" />
        <SaveLine status={status} botName={botName} graph={draft} onRetry={retry} onReload={reload} />
        {onUseInRoutine && (
          <button type="button" onClick={() => onUseInRoutine(workflow)} className="ui-button ui-button-primary">{t("workflow.useInRoutine")}</button>
        )}
        <div className="flex flex-col items-end">
          <button type="button" aria-disabled={usedBy.length > 0 || undefined} aria-describedby={usedBy.length > 0 ? reasonId : undefined} onClick={() => void deleteWorkflow()}
            className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-danger outline-none hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-focus aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent">
            <Trash2 size={15} aria-hidden />{t("workflow.delete")}
          </button>
        </div>
      </div>
      {usedBy.length > 0 && <p id={reasonId} className="shrink-0 px-4 pt-2 text-right text-[12px] leading-4 text-ink-secondary">{t("workflow.deleteInUse", { routines: listOf(usedBy.map(routineLabel)) })}</p>}
      {deleteFailed && <p role="alert" className="shrink-0 px-4 pt-2 text-right text-[12px] text-danger">{t("workflow.save.failed")}</p>}
      {runBlockText && (
        <p data-workflow-warning className="shrink-0 border-b border-hairline/35 bg-warning/10 px-4 py-2 text-[13px] leading-[18px] text-warning">
          {usedBy.length > 0 ? t("workflow.linkedProblem", { routines: listOf(usedBy.map(routineLabel)), reason: runBlockText }) : t("workflow.notRunnable", { reason: runBlockText })}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative flex min-h-[320px] min-w-0 flex-1 flex-col">
          <WorkflowCanvas graph={draft} botName={botName} selectedId={selected?.id ?? null} onSelect={setSelectedId} label={t("workflow.region")}
            centerRef={center} onDropStep={(kind, at) => place(kind, at)}
            edit={{ dispatch, problems: stepProblems, onRemove: removeStep, onAnnounce: setAnnouncement }} />
          <div className="absolute left-4 top-4 z-10"><WorkflowPalette onAdd={add} /></div>
          {draft.steps.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-xl bg-app/90 px-6 py-4 text-center">
                <p className="text-[13px] text-ink-secondary">{t("workflow.empty")}</p>
                <button type="button" onClick={() => add("bot")} className="ui-button ui-button-primary">{t("workflow.emptyAction")}</button>
              </div>
            </div>
          )}
        </div>
        <WorkflowStepPanel draft={draft} step={selected} bots={panelBots} botName={botName} problem={selected ? stepProblems[selected.id] : undefined}
          dispatch={dispatch} onRemove={removeStep} onAnnounce={setAnnouncement} />
      </div>
      <p role="status" className="sr-only">{announcement}</p>
      {undo && <UndoToast key={undo.key} text={undo.text} onUndo={undoRemoval} onDone={undoDone} />}
    </div>
  );
}

function SaveLine({ status, graph, botName, onRetry, onReload }: {
  status: SaveStatus;
  graph: Parameters<typeof problemText>[1];
  botName: (botId: string) => string | undefined;
  onRetry: () => void;
  onReload: () => void;
}) {
  const text = status.state === "saved" ? t("workflow.save.saved")
    : status.state === "saving" ? t("workflow.save.saving")
    : status.state === "unsaved" ? t("workflow.save.unsaved", { reason: problemText(status.problem, graph, botName) })
    : status.state === "refused" ? status.text
    : status.state === "changed" ? t("workflow.problem.changed")
    : t("workflow.save.failed");
  return (
    <div role="status" aria-live="polite" data-workflow-save={status.state} className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-ink-secondary">
      <span className="min-w-0">{text}</span>
      {status.state === "changed" && <button type="button" onClick={onReload} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised">{t("workflow.reload")}</button>}
      {status.state === "failed" && <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised">{t("common.tryAgain")}</button>}
    </div>
  );
}
