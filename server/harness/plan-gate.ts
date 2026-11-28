// Sends turn.plan only when a turn's counts change. A turn's memory ends with the turn.
import { TURN_PLAN_MAX } from "../../shared/turn-plan.ts";
import type { RuntimeEvent } from "../contracts.ts";

export type PlanEvent = Extract<RuntimeEvent, { type: "turn.plan" }>;

interface Shown {
  turnId: string | undefined;
  done: number;
  total: number;
}

function valid(event: PlanEvent): boolean {
  return Number.isInteger(event.total) && Number.isInteger(event.done) &&
    event.total >= 1 && event.total <= TURN_PLAN_MAX && event.done >= 0 && event.done <= event.total;
}

export class PlanGate {
  private readonly shown = new Map<string, Shown>();

  /** True when the report is well formed and differs from the last one of its turn. */
  changed(event: PlanEvent): boolean {
    if (!valid(event)) return false;
    const last = this.shown.get(event.threadId);
    if (last && last.turnId === event.turnId && last.done === event.done && last.total === event.total) return false;
    this.shown.set(event.threadId, { turnId: event.turnId, done: event.done, total: event.total });
    return true;
  }

  forget(threadId: string): void {
    this.shown.delete(threadId);
  }
}
