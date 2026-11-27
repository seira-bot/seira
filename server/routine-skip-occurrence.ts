import { z } from "zod";

import { runsOnce } from "../shared/limit-reset.ts";
import { MAX_DATE_MS } from "./routine-request-schemas.ts";
import { nextOccurrence, type RoutineSchedule } from "./routine-schedules.ts";

export const MAX_SKIPPED_OCCURRENCES = 50;

export const routineSkipBody = z.object({ at: z.number().int().nonnegative().max(MAX_DATE_MS), skip: z.boolean() }).strict();

type Skippable = { enabled: boolean; schedule: RoutineSchedule; skippedOccurrences?: number[] };

const listOf = (skipped: unknown): readonly number[] => Array.isArray(skipped) ? skipped.filter((at): at is number => Number.isFinite(at)) : [];

export function occurrenceSkipped(routine: { skippedOccurrences?: number[] }, at: number): boolean {
  return listOf(routine.skippedOccurrences).includes(at);
}

export function nextUnskippedOccurrence(schedule: RoutineSchedule, from: number, skipped: readonly number[] | undefined): number | null {
  const list = listOf(skipped);
  let next = nextOccurrence(schedule, from);
  for (let step = 0; step <= list.length && next !== null && list.includes(next); step += 1) next = nextOccurrence(schedule, next);
  return next;
}

export function withoutPastSkips(skipped: readonly number[] | undefined, now: number): number[] | undefined {
  const kept = [...new Set(listOf(skipped).filter((at) => at > now))].sort((a, b) => a - b);
  return kept.length ? kept : undefined;
}

export function withSkip(skipped: readonly number[] | undefined, at: number, now: number): number[] {
  return (withoutPastSkips([...listOf(skipped), at], now) ?? []).slice(0, MAX_SKIPPED_OCCURRENCES);
}

export function skipRefusal(routine: Skippable, at: number, now: number): string | null {
  if (routine.schedule.type === "limit_reset" || runsOnce(routine.schedule)) return "This routine runs only once, so there is nothing to skip. Turn it off instead.";
  if (!routine.enabled) return "This routine is off.";
  if (at <= now) return "That time has already passed.";
  if (nextOccurrence(routine.schedule, at - 1) !== at) return "The routine does not run at that time.";
  if (!occurrenceSkipped(routine, at) && (withoutPastSkips(routine.skippedOccurrences, now)?.length ?? 0) >= MAX_SKIPPED_OCCURRENCES) return "Too many times are skipped already. Undo one first.";
  return null;
}
