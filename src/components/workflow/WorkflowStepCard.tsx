import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, Bot, Check, Circle, Hourglass, Loader2, Minus, Send, Split, StickyNote, X, type LucideIcon } from "lucide-react";

import type { WorkflowStep, WorkflowStepKind } from "../../../shared/workflows";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { reducedMotion } from "@/lib/onboarding";
import { stepSize, type PortSide } from "@/lib/workflow-canvas";
import type { StepView } from "@/lib/workflow-run";

const KIND_ICON: Record<WorkflowStepKind, LucideIcon> = { bot: Bot, check: Split, wait: Hourglass, post: Send, note: StickyNote };

const PORT_LEFT: Record<PortSide, string> = { out: "50%", yes: "33.333%", no: "66.667%" };

export function StatusMark({ state, reduced }: { state: StepView["state"]; reduced: boolean }) {
  switch (state) {
    case "done": return <Check size={14} aria-hidden className="mt-px shrink-0 text-success" />;
    case "failed": return <X size={14} aria-hidden className="mt-px shrink-0 text-danger" />;
    case "running": return reduced
      ? <span aria-hidden className="mx-1 mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
      : <Loader2 size={14} aria-hidden className="mt-px shrink-0 animate-spin text-accent motion-reduce:animate-none" />;
    case "waiting": return <Hourglass size={14} aria-hidden className="mt-px shrink-0 text-warning" />;
    case "skipped":
    case "not_run": return <Minus size={14} aria-hidden className="mt-px shrink-0 text-ink-tertiary" />;
    case "carried": return <Check size={14} aria-hidden className="mt-px shrink-0 text-ink-secondary" />;
    case "not_started": return <Circle size={14} aria-hidden className="mt-px shrink-0 text-ink-tertiary" />;
  }
}

const statusColor = (state: StepView["state"]): string =>
  state === "failed" ? "text-danger" : state === "waiting" ? "text-warning" : state === "skipped" || state === "not_run" ? "text-ink-tertiary" : "text-ink-secondary";

export function WorkflowStepCard({ step, title, kindLabel, selected, problem, status, readOnly, onPointerDown, onKeyDown, onClick, onPortPointerDown }: {
  step: WorkflowStep;
  title: string;
  kindLabel: string;
  selected: boolean;
  problem?: string;
  status?: { view: StepView; text: string };
  readOnly: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onClick: () => void;
  onPortPointerDown?: (event: ReactPointerEvent<HTMLSpanElement>, side: PortSide) => void;
}) {
  const reduced = reducedMotion();
  const Icon = KIND_ICON[step.kind];
  const note = step.kind === "note";
  const { width, height } = stepSize(step);
  const detailId = `workflow-step-${step.id}-detail`;
  const hasDetail = Boolean(problem || status);
  const doing = step.kind === "bot" ? step.instruction.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined;
  const sides: PortSide[] = step.kind === "check" ? ["yes", "no"] : ["out"];
  return (
    <button type="button" data-workflow-step={step.id} data-step-status={status?.view.state} aria-label={t("workflow.step.label", { kind: kindLabel, title })}
      aria-describedby={hasDetail ? detailId : undefined} aria-current={selected || undefined}
      onPointerDown={onPointerDown} onKeyDown={onKeyDown} onClick={onClick}
      className={cn(
        "absolute touch-none select-none rounded-xl border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus",
        note ? "border-transparent bg-inset" : "border-hairline/50 bg-card",
        selected && "ring-2 ring-accent",
        readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        status?.view.state === "skipped" || status?.view.state === "not_run" ? "opacity-60" : "",
        !reduced && "transition-shadow duration-150 motion-reduce:transition-none",
      )}
      style={{ left: step.position.x, top: step.position.y, width, height }}>
      <span className="flex min-h-5 items-center gap-2 text-ink-secondary">
        <Icon size={16} aria-hidden className="shrink-0" />
        <span className="truncate text-[12px] leading-4 text-ink-tertiary">{kindLabel}</span>
      </span>
      <span className={cn("mt-1 block text-[13px] leading-[18px] text-ink", doing ? "line-clamp-1" : "line-clamp-2", note ? "font-normal" : "font-medium")} dir="auto">{title}</span>
      {doing && <span data-workflow-step-instruction className="block line-clamp-1 text-[12px] leading-4 text-ink-secondary" dir="auto">{doing}</span>}
      {hasDetail && (
        <span id={detailId} className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-4">
          {problem ? (
            <span className="flex items-start gap-1.5 text-warning">
              <AlertTriangle size={14} aria-hidden className="mt-px shrink-0" />
              <span>{t("workflow.problemMark")}</span>
              <span className="sr-only">{problem}</span>
            </span>
          ) : status && (
            <span className={cn("flex items-start gap-1.5", statusColor(status.view.state))}>
              <StatusMark state={status.view.state} reduced={reduced} />
              <span className="line-clamp-1">{status.text}</span>
            </span>
          )}
        </span>
      )}
      {onPortPointerDown && !note && sides.map((side) => (
        <span key={side} aria-hidden data-workflow-port={side} onPointerDown={(event) => { event.stopPropagation(); onPortPointerDown(event, side); }}
          className="absolute bottom-0 flex size-6 -translate-x-1/2 translate-y-1/2 cursor-crosshair items-center justify-center" style={{ left: PORT_LEFT[side] }}>
          <span className="size-3 rounded-full border-2 border-ink-tertiary bg-card" />
          {step.kind === "check" && <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 text-[10px] leading-3 text-ink-tertiary">{t(side === "yes" ? "workflow.branch.yes" : "workflow.branch.no")}</span>}
        </span>
      ))}
    </button>
  );
}
