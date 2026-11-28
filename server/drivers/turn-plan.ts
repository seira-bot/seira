// Each engine's task list, read into the counts of a turn.plan event. Nothing but the two counts leaves this file.
import { TURN_PLAN_MAX, type TurnPlanFields } from "../../shared/turn-plan.ts";

/** Entries that are not objects are ignored; a list with no object entry has no plan. */
export function planCounts(list: unknown, completed: (item: Record<string, unknown>) => boolean): TurnPlanFields | null {
  if (!Array.isArray(list)) return null;
  let total = 0;
  let done = 0;
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    total += 1;
    if (completed(item as Record<string, unknown>)) done += 1;
  }
  if (total === 0) return null;
  return { type: "turn.plan", done: Math.min(done, TURN_PLAN_MAX), total: Math.min(total, TURN_PLAN_MAX) };
}

/** The input of Claude's TodoWrite tool: `{ todos: [{ content, status, activeForm }] }`. */
export function claudeTodoPlan(input: unknown): TurnPlanFields | null {
  const todos = input && typeof input === "object" ? (input as { todos?: unknown }).todos : undefined;
  return planCounts(todos, (todo) => todo.status === "completed");
}

/** Codex app-server's turn/plan/updated params: `{ plan: [{ step, status: "pending" | "inProgress" | "completed" }] }`. */
export function codexTurnPlan(params: unknown): TurnPlanFields | null {
  const plan = params && typeof params === "object" ? (params as { plan?: unknown }).plan : undefined;
  return planCounts(plan, (step) => step.status === "completed");
}

/** An ACP session update of kind "plan": `{ entries: [{ content, priority, status: "pending" | "in_progress" | "completed" }] }`. */
export function acpTurnPlan(update: unknown): TurnPlanFields | null {
  const entries = update && typeof update === "object" ? (update as { entries?: unknown }).entries : undefined;
  return planCounts(entries, (entry) => entry.status === "completed");
}
