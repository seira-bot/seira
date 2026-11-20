import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { Minus, Plus } from "lucide-react";

import type { WorkflowGraph, WorkflowStep, WorkflowStepKind } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { reducedMotion } from "@/lib/onboarding";
import { zoomAt, type Point, type View } from "@/lib/team-canvas";
import { fitSteps, MAX_SCALE, MIN_SCALE, newId, portPoint, refusalKey, START_VIEW, STEP_DRAG_TYPE, type DraftAction, type PortSide } from "@/lib/workflow-canvas";
import { connectRefusal, KIND_LABEL, readingOrder, stepTitle } from "@/lib/workflow-graph";
import { stepStatusText, type StepView } from "@/lib/workflow-run";
import { WorkflowEdges, type PendingConnection } from "./WorkflowEdges";
import { WorkflowStepCard } from "./WorkflowStepCard";

export interface WorkflowCanvasEdit {
  dispatch: (action: DraftAction) => void;
  problems: Record<string, string>;
  onRemove: (stepId: string) => void;
  onAnnounce: (text: string) => void;
}

type Gesture =
  | { kind: "pan"; id: number; start: Point; origin: View; moved: boolean }
  | { kind: "step"; id: number; start: Point; step: WorkflowStep; scale: number; moved: boolean }
  | { kind: "connect"; id: number; start: Point; step: WorkflowStep; side: PortSide; moved: boolean };

const DRAG_THRESHOLD = 5;
const ANNOUNCE_DELAY_MS = 600;
const ZOOM_STEP = 1.2;
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const STEP_KINDS: readonly WorkflowStepKind[] = ["bot", "check", "wait", "post", "note"];

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

export function WorkflowCanvas({ graph, botName, selectedId, onSelect, label, edit, statuses, onDropStep, centerRef }: {
  graph: WorkflowGraph;
  botName: (botId: string) => string | undefined;
  selectedId: string | null;
  onSelect: (stepId: string | null) => void;
  label: string;
  edit?: WorkflowCanvasEdit;
  statuses?: Record<string, StepView>;
  onDropStep?: (kind: WorkflowStepKind, at: Point) => void;
  /** Filled with a function that gives the world point at the middle of what shows. */
  centerRef?: MutableRefObject<(() => Point) | null>;
}) {
  const hintId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const keyboardFocus = useRef(false);
  const announceTimer = useRef<number | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [view, setView] = useState<View>(START_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drag, setDrag] = useState<{ id: string; position: Point } | null>(null);
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
  const reduced = reducedMotion();

  const shown: WorkflowGraph = drag
    ? { ...graph, steps: graph.steps.map((step) => step.id === drag.id ? { ...step, position: drag.position } : step) }
    : graph;
  const shownById = new Map(shown.steps.map((step) => [step.id, step]));
  const order = readingOrder(graph).flatMap((step) => shownById.get(step.id) ?? []);

  const toWorld = (clientX: number, clientY: number): Point => {
    const bounds = viewport.current?.getBoundingClientRect();
    return { x: (clientX - (bounds?.left ?? 0) - view.x) / view.scale, y: (clientY - (bounds?.top ?? 0) - view.y) / view.scale };
  };
  const fit = () => {
    const bounds = viewport.current?.getBoundingClientRect();
    setView(fitSteps(graphRef.current.steps, bounds?.width ?? 0, bounds?.height ?? 0));
  };
  const zoom = (factor: number) => {
    const bounds = viewport.current?.getBoundingClientRect();
    const center = { x: (bounds?.width ?? 0) / 2, y: (bounds?.height ?? 0) / 2 };
    setView(zoomAt(view, clampScale(view.scale * factor), center));
  };

  useLayoutEffect(fit, []);
  useEffect(() => {
    if (!centerRef) return;
    centerRef.current = () => {
      const bounds = viewport.current?.getBoundingClientRect();
      return toWorld((bounds?.left ?? 0) + (bounds?.width ?? 0) / 2, (bounds?.top ?? 0) + (bounds?.height ?? 0) / 2);
    };
    return () => { centerRef.current = null; };
  });
  useEffect(() => () => { if (announceTimer.current !== null) window.clearTimeout(announceTimer.current); }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (gesture.current) return;
      const previous = viewRef.current;
      const bounds = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const scale = clampScale(previous.scale * Math.exp(-event.deltaY * 0.006));
        setView(zoomAt(previous, scale, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }));
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
        setView({ ...previous, x: previous.x - event.deltaX * unit, y: previous.y - event.deltaY * unit });
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const begin = (event: ReactPointerEvent<HTMLElement>, make: (id: number, start: Point) => Gesture) => {
    if (event.button !== 0 || gesture.current) return;
    gesture.current = make(event.pointerId, { x: event.clientX, y: event.clientY });
    suppressClick.current = false;
  };
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, [data-workflow-connection-hit]")) return;
    begin(event, (id, from) => ({ kind: "pan", id, start: from, origin: view, moved: false }));
  };
  const startStep = (event: ReactPointerEvent<HTMLButtonElement>, step: WorkflowStep) => {
    if (!edit) return;
    begin(event, (id, from) => ({ kind: "step", id, start: from, step, scale: view.scale, moved: false }));
  };
  const startPort = (event: ReactPointerEvent<HTMLSpanElement>, step: WorkflowStep, side: PortSide) => {
    begin(event, (id, from) => ({ kind: "connect", id, start: from, step, side, moved: false }));
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.start.x;
    const dy = event.clientY - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    active.moved = true;
    viewport.current?.setPointerCapture?.(event.pointerId);
    if (active.kind === "pan") setView({ ...active.origin, x: active.origin.x + dx, y: active.origin.y + dy });
    else if (active.kind === "step") setDrag({ id: active.step.id, position: { x: active.step.position.x + dx / active.scale, y: active.step.position.y + dy / active.scale } });
    else setPending({ from: portPoint(active.step, active.side), to: toWorld(event.clientX, event.clientY) });
  };

  const finish = (event?: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const active = gesture.current;
    if (!active || (event && active.id !== event.pointerId)) return;
    gesture.current = null;
    suppressClick.current = active.moved;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    setDrag(null);
    setPending(null);
    if (viewport.current?.hasPointerCapture?.(active.id)) viewport.current.releasePointerCapture(active.id);
    if (cancelled) {
      if (active.kind === "pan") setView(active.origin);
      return;
    }
    if (!active.moved) {
      if (active.kind === "pan") { onSelect(null); setSelectedConnection(null); }
      else if (active.kind === "step") { onSelect(active.step.id); setSelectedConnection(null); }
      return;
    }
    if (!event || !edit) return;
    if (active.kind === "step") {
      const position = { x: active.step.position.x + (event.clientX - active.start.x) / active.scale, y: active.step.position.y + (event.clientY - active.start.y) / active.scale };
      edit.dispatch({ type: "move", stepId: active.step.id, position });
      edit.onAnnounce(t("workflow.announce.moved", { step: stepTitle(active.step, botName) }));
    } else if (active.kind === "connect") {
      const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-step]")?.dataset.workflowStep;
      const target = targetId ? graph.steps.find((step) => step.id === targetId) : undefined;
      if (!target) return;
      const branch = active.side === "out" ? undefined : active.side;
      const refusal = connectRefusal(graph, active.step.id, target.id, branch);
      if (refusal) { edit.onAnnounce(t(refusalKey(refusal))); return; }
      edit.dispatch({ type: "connect", connection: { id: newId("c"), from: active.step.id, to: target.id, ...(branch ? { branch } : {}) } });
      edit.onAnnounce(t("workflow.announce.connected", { from: stepTitle(active.step, botName), to: stepTitle(target, botName) }));
    }
  };

  const stepKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, step: WorkflowStep) => {
    if (!edit) return;
    const delta = ARROWS[event.key];
    if (delta) {
      event.preventDefault();
      const amount = event.shiftKey ? 40 : 8;
      edit.dispatch({ type: "move", stepId: step.id, position: { x: step.position.x + delta[0] * amount, y: step.position.y + delta[1] * amount } });
      if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
      announceTimer.current = window.setTimeout(() => edit.onAnnounce(t("workflow.announce.moved", { step: stepTitle(step, botName) })), ANNOUNCE_DELAY_MS);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      edit.onRemove(step.id);
    }
  };

  const removeConnection = (connectionId: string) => {
    const connection = graph.connections.find((candidate) => candidate.id === connectionId);
    const from = connection && graph.steps.find((step) => step.id === connection.from);
    const to = connection && graph.steps.find((step) => step.id === connection.to);
    edit?.dispatch({ type: "disconnect", connectionId });
    setSelectedConnection(null);
    if (from && to) edit?.onAnnounce(t("workflow.announce.disconnected", { from: stepTitle(from, botName), to: stepTitle(to, botName) }));
  };

  const acceptsDrop = (types: readonly string[] | DOMStringList) => Boolean(edit && onDropStep && Array.from(types).includes(STEP_DRAG_TYPE));

  return (
    <div ref={viewport} role="region" aria-label={label} aria-describedby={hintId} tabIndex={0} data-workflow-canvas data-reduced-motion={reduced ? "true" : "false"}
      className="relative min-h-0 flex-1 touch-none overflow-clip bg-panel outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      style={{ backgroundImage: "radial-gradient(circle, color-mix(in srgb, var(--color-ink-secondary) 18%, transparent) 1px, transparent 1px)", backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={() => { if (gesture.current?.moved) finish(undefined, true); }}
      onDragOver={(event) => {
        if (!acceptsDrop(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!acceptsDrop(event.dataTransfer.types)) return;
        event.preventDefault();
        const kind = event.dataTransfer.getData(STEP_DRAG_TYPE) as WorkflowStepKind;
        if (STEP_KINDS.includes(kind)) onDropStep?.(kind, toWorld(event.clientX, event.clientY));
      }}
      onKeyDownCapture={(event) => { if (event.key === "Tab") keyboardFocus.current = true; }}
      onPointerDownCapture={() => { keyboardFocus.current = false; }}
      onFocusCapture={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (!keyboardFocus.current || bounds.width === 0 || !(event.target instanceof HTMLElement) || !event.target.closest("[data-workflow-step]")) return;
        const target = event.target.getBoundingClientRect();
        const dx = target.left < bounds.left + 16 ? bounds.left + 16 - target.left : target.right > bounds.right - 16 ? bounds.right - 16 - target.right : 0;
        const dy = target.top < bounds.top + 16 ? bounds.top + 16 - target.top : target.bottom > bounds.bottom - 70 ? bounds.bottom - 70 - target.bottom : 0;
        if (dx || dy) setView((previous) => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
      }}
      onClickCapture={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { finish(undefined, true); onSelect(null); setSelectedConnection(null); }
        if (event.target !== event.currentTarget) return;
        const delta = ARROWS[event.key];
        if (delta) { event.preventDefault(); setView({ ...view, x: view.x - delta[0] * 60, y: view.y - delta[1] * 60 }); }
        if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(ZOOM_STEP); }
        if (event.key === "-") { event.preventDefault(); zoom(1 / ZOOM_STEP); }
        if (event.key === "0") { event.preventDefault(); fit(); }
      }}>
      <span id={hintId} className="sr-only">{t("workflow.regionHint")}</span>
      <div data-workflow-world className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <WorkflowEdges graph={shown} botName={botName} selectedId={selectedConnection} editable={Boolean(edit)} pending={pending}
          onSelect={(id) => { setSelectedConnection(id); onSelect(null); }} onRemove={removeConnection} />
        {order.map((step) => {
          const stepView = statuses?.[step.id];
          return (
            <WorkflowStepCard key={step.id} step={step} title={stepTitle(step, botName)} kindLabel={t(KIND_LABEL[step.kind])}
              selected={step.id === selectedId} problem={edit?.problems[step.id]} readOnly={!edit}
              status={stepView ? { view: stepView, text: stepStatusText(stepView, step, botName) } : undefined}
              onPointerDown={(event) => startStep(event, step)} onKeyDown={(event) => stepKeyDown(event, step)}
              onClick={() => { onSelect(step.id); setSelectedConnection(null); }}
              onPortPointerDown={edit ? (event, side) => startPort(event, step, side) : undefined} />
          );
        })}
      </div>
      <div className="pointer-events-none absolute bottom-4 right-4 flex">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-hairline/60 bg-panel p-1 shadow-sm">
          <button type="button" aria-label={t("canvas.zoomOut")} onClick={() => zoom(1 / ZOOM_STEP)} className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"><Minus size={15} aria-hidden /></button>
          <button type="button" aria-label={t("workflow.fit")} title={t("workflow.fitHint")} onClick={fit} className="min-w-12 rounded-md px-1 py-2 text-[11px] tabular-nums text-ink-secondary hover:bg-control focus-visible:outline-2 focus-visible:outline-accent">{Math.round(view.scale * 100)}%</button>
          <button type="button" aria-label={t("canvas.zoomIn")} onClick={() => zoom(ZOOM_STEP)} className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"><Plus size={15} aria-hidden /></button>
        </div>
      </div>
    </div>
  );
}
