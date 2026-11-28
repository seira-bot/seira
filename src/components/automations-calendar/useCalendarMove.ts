import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { moveSchedule, shortSchedule, type Occurrence } from "@/lib/automation-calendar";
import { t } from "@/lib/i18n";
import type { RoutineSchedule } from "@/lib/routines";
import { schedulePhrase } from "./phrases";

const DRAG_DISTANCE = 4;
const TOAST_MS = 10_000;

export interface MoveSubject { name: string; schedule: RoutineSchedule }
export interface MoveDrag { key: string; overAt: number | null; phrase: string | null }
export interface MoveToastState { message: string; failed: boolean; undo?: () => void; undoing?: boolean }

interface Press { occurrence: Occurrence; x: number; y: number; moved: boolean; overAt: number | null }

const hourStart = (at: number) => new Date(at).setMinutes(0, 0, 0);
const dropTarget = (occurrence: Occurrence, slotAt: number) => slotAt + (occurrence.at - hourStart(occurrence.at));

/** The hour slot under the pointer, even when a card sits above it. */
function slotUnder(event: PointerEvent): number | null {
  const stack = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(event.clientX, event.clientY) : [];
  const element = stack.length
    ? stack.map((candidate) => candidate.closest("[data-slot-at]")).find((slot) => slot !== null)
    : (event.target as Element | null)?.closest?.("[data-slot-at]");
  return element ? Number(element.getAttribute("data-slot-at")) : null;
}

/** Drag a future card onto another slot to change when its start runs; the toast offers Undo. */
export function useCalendarMove({ find, save, now }: {
  find: (occurrence: Occurrence) => MoveSubject | null;
  save: (startId: string, schedule: RoutineSchedule) => Promise<void>;
  now: number;
}) {
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const [toast, setToast] = useState<MoveToastState | null>(null);
  const press = useRef<Press | null>(null);
  const blockClick = useRef(false);
  const saving = useRef(new Set<string>());
  const nowRef = useRef(now);
  const findRef = useRef(find);
  const saveRef = useRef(save);
  const commitRef = useRef<(occurrence: Occurrence, slotAt: number) => Promise<void>>(async () => {});
  findRef.current = find;
  saveRef.current = save;
  nowRef.current = now;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const commit = useCallback(async (occurrence: Occurrence, slotAt: number) => {
    const subject = findRef.current(occurrence);
    if (!subject || saving.current.has(occurrence.startId)) return;
    const next = moveSchedule(subject.schedule, occurrence.at, dropTarget(occurrence, slotAt), true, nowRef.current);
    if (!next) return;
    saving.current.add(occurrence.startId);
    const failed = () => setToast({ message: t("automations.cal.moveFailed", { name: subject.name }), failed: true });
    try { await saveRef.current(occurrence.startId, next); } catch { failed(); return; } finally { saving.current.delete(occurrence.startId); }
    const phrase = shortSchedule(next);
    const undo = () => {
      const current = findRef.current(occurrence);
      if (saving.current.has(occurrence.startId)) return;
      if (!current || JSON.stringify(current.schedule) !== JSON.stringify(next)) { setToast(null); return; }
      saving.current.add(occurrence.startId);
      setToast((shown) => (shown ? { ...shown, undoing: true } : shown));
      void saveRef.current(occurrence.startId, subject.schedule)
        .then(() => setToast(null), () => setToast({ message: t("automations.cal.undoFailed", { name: subject.name }), failed: true }))
        .finally(() => { saving.current.delete(occurrence.startId); });
    };
    setToast({ message: t("automations.cal.moved", { name: subject.name, when: phrase ? schedulePhrase(phrase) : "" }), failed: false, undo });
  }, []);
  commitRef.current = commit;

  const listeners = useRef<{ move: (event: PointerEvent) => void; up: () => void; cancel: () => void; key: (event: KeyboardEvent) => void } | null>(null);
  if (!listeners.current) {
    const detach = () => {
      const all = listeners.current!;
      window.removeEventListener("pointermove", all.move);
      window.removeEventListener("pointerup", all.up);
      window.removeEventListener("pointercancel", all.cancel);
      window.removeEventListener("keydown", all.key);
    };
    const stop = (drop: boolean) => {
      const current = press.current;
      press.current = null;
      detach();
      setDrag(null);
      if (!current?.moved) return;
      blockClick.current = true;
      window.setTimeout(() => { blockClick.current = false; }, 0);
      if (drop && current.overAt !== null) void commitRef.current(current.occurrence, current.overAt);
    };
    listeners.current = {
      move: (event) => {
        const current = press.current;
        if (!current) return;
        const slotAt = slotUnder(event);
        const far = Math.hypot(event.clientX - current.x, event.clientY - current.y) >= DRAG_DISTANCE;
        if (!current.moved && !far && (slotAt === null || slotAt === hourStart(current.occurrence.at))) return;
        current.moved = true;
        current.overAt = slotAt;
        const subject = findRef.current(current.occurrence);
        const next = subject && slotAt !== null ? moveSchedule(subject.schedule, current.occurrence.at, dropTarget(current.occurrence, slotAt), true, nowRef.current) : null;
        const phrase = next && shortSchedule(next);
        current.overAt = next ? slotAt : null;
        setDrag({ key: current.occurrence.key, overAt: current.overAt, phrase: phrase ? schedulePhrase(phrase) : null });
      },
      up: () => stop(true),
      cancel: () => stop(false),
      key: (event) => { if (event.key === "Escape") stop(false); },
    };
  }

  useEffect(() => () => {
    const all = listeners.current!;
    window.removeEventListener("pointermove", all.move);
    window.removeEventListener("pointerup", all.up);
    window.removeEventListener("pointercancel", all.cancel);
    window.removeEventListener("keydown", all.key);
  }, []);

  const begin = useCallback((occurrence: Occurrence, event: ReactPointerEvent) => {
    if (!occurrence.canMove || saving.current.has(occurrence.startId) || (event.button !== undefined && event.button !== 0)) return;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
    press.current = { occurrence, x: event.clientX, y: event.clientY, moved: false, overAt: null };
    const all = listeners.current!;
    window.addEventListener("pointermove", all.move);
    window.addEventListener("pointerup", all.up);
    window.addEventListener("pointercancel", all.cancel);
    window.addEventListener("keydown", all.key);
  }, []);

  /** True once for the click that ends a drag, so a drop never opens the panel. */
  const consumeClick = useCallback(() => {
    const blocked = blockClick.current;
    blockClick.current = false;
    return blocked;
  }, []);

  return { drag, toast, begin, consumeClick, dismiss: () => setToast(null) };
}
