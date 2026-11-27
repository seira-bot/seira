import { nextCronRuns } from "../../shared/routine-schedule";
import { addDays, atLocalTime, startOfDay, startOfWeek } from "@/lib/routine-calendar";
import { isCountedSkip, type RoutineRun, type RoutineSchedule } from "@/lib/routines";

export type CalendarStart =
  | { id: string; kind: "schedule"; schedule: RoutineSchedule; enabled: boolean; nextRunAt?: number | null; createdAt?: number }
  | { id: string; kind: "webhook" | "app"; app?: string };

export interface CalendarAutomation {
  id: string;
  name: string;
  enabled: boolean;
  draft: boolean;
  manual: boolean;
  needsYou: boolean;
  statusLine: string;
  starts: CalendarStart[];
  stepBotIds: string[];
  /** Newest first; each run belongs to a start through `routineId`. */
  runs: RoutineRun[];
  workflowId?: string;
}

export type OccurrenceKind = "scheduled" | "past-run" | "app-run" | "missed";
export type OccurrenceRunStatus = "done" | "failed" | "running" | "skipped";

export interface Occurrence {
  /** `automationId|startId|epochMs`. */
  key: string;
  at: number;
  automationId: string;
  startId: string;
  kind: OccurrenceKind;
  runStatus?: OccurrenceRunStatus;
  multi: boolean;
  canMove: boolean;
}

export const GRID_FIRST_HOUR = 7;
export const GRID_LAST_HOUR = 22;
export const MONTH_CHIPS_PER_DAY = 3;
const MONTH_WEEKS = 6;
const RUN_TOLERANCE_MS = 60_000;
const MAX_CRON_PER_RANGE = 400;

const runTime = (run: RoutineRun) => run.startedAt ?? run.scheduledFor ?? run.createdAt;

function runStatusOf(run: RoutineRun): OccurrenceRunStatus {
  if (isCountedSkip(run)) return "skipped";
  if (run.status === "completed") return "done";
  if (run.status === "running" || run.status === "queued" || run.status === "waiting") return "running";
  return "failed";
}

function scheduledTimes(schedule: RoutineSchedule, from: number, to: number, start: Extract<CalendarStart, { kind: "schedule" }>, upcoming = false): number[] {
  const since = start.createdAt ?? 0;
  const inRange = (at: number) => at >= from && at < to && at >= since;
  if (schedule.type === "once") return inRange(schedule.at) ? [schedule.at] : [];
  if (schedule.type === "daily") {
    const times: number[] = [];
    for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
      if (!schedule.weekdays.includes(new Date(day).getDay())) continue;
      const at = atLocalTime(day, schedule.time);
      if (inRange(at)) times.push(at);
    }
    return times;
  }
  if (schedule.type === "cron") {
    const floor = Math.max(from, since, upcoming ? start.nextRunAt ?? 0 : 0);
    return nextCronRuns(schedule, floor - 1, MAX_CRON_PER_RANGE).filter(inRange);
  }
  const next = start.nextRunAt;
  return next != null && inRange(next) ? [next] : [];
}

const canMoveSchedule = (schedule: RoutineSchedule) => schedule.type === "once" || schedule.type === "daily";

export function occurrencesIn(automations: readonly CalendarAutomation[], from: number, to: number, now: number): Occurrence[] {
  const result: Occurrence[] = [];
  for (const automation of automations) {
    const scheduleStarts = automation.starts.filter((start): start is Extract<CalendarStart, { kind: "schedule" }> => start.kind === "schedule");
    const multi = scheduleStarts.length >= 2;
    const add = (startId: string, at: number, kind: OccurrenceKind, extra: Partial<Occurrence> = {}) => {
      result.push({ key: `${automation.id}|${startId}|${at}`, at, automationId: automation.id, startId, kind, multi, canMove: false, ...extra });
    };
    const runsOf = (startId: string) => automation.runs.filter((run) => run.routineId === startId);

    for (const start of scheduleStarts) {
      const runs = runsOf(start.id);
      const hasRun = (at: number) => runs.some((run) => Math.abs(run.scheduledFor - at) < RUN_TOLERANCE_MS);
      for (const run of runs) {
        const at = run.scheduledFor ?? runTime(run);
        if (at < from || at >= to || at > now) continue;
        if (run.status === "missed") add(start.id, at, "missed");
        else add(start.id, at, "past-run", { runStatus: runStatusOf(run) });
      }
      if (automation.needsYou && from < now) {
        for (const at of scheduledTimes(start.schedule, from, Math.min(to, now), start)) if (!hasRun(at)) add(start.id, at, "missed");
      }
      if (automation.enabled && start.enabled && to > now) {
        const canMove = canMoveSchedule(start.schedule);
        for (const at of scheduledTimes(start.schedule, Math.max(now, from), to, start, true)) {
          if (at > now && !hasRun(at)) add(start.id, at, "scheduled", { canMove });
        }
      }
    }
    for (const start of automation.starts) {
      if (start.kind === "schedule") continue;
      for (const run of runsOf(start.id)) {
        const at = runTime(run);
        if (at >= from && at < to && at <= now) add(start.id, at, "app-run", { runStatus: runStatusOf(run) });
      }
    }
  }
  return result.sort((left, right) => left.at - right.at || left.key.localeCompare(right.key));
}

export interface GridHours {
  /** First hour row shown. */
  start: number;
  /** One past the last hour row shown. */
  end: number;
  /** Show the "Nothing runs before 07:00" row: nothing falls before the default window. */
  before: boolean;
  /** Show the "Nothing runs after 22:00" row: nothing falls after the default window. */
  after: boolean;
}

export function gridHours(occurrences: readonly Pick<Occurrence, "at">[], extraTimes: readonly number[] = []): GridHours {
  let start = GRID_FIRST_HOUR;
  let end = GRID_LAST_HOUR;
  for (const at of [...occurrences.map((occurrence) => occurrence.at), ...extraTimes]) {
    const hour = new Date(at).getHours();
    if (hour < start) start = hour;
    if (hour >= end) end = hour + 1;
  }
  return { start, end, before: start === GRID_FIRST_HOUR, after: end === GRID_LAST_HOUR };
}

export interface MonthCell {
  /** Start of the day. */
  day: number;
  inMonth: boolean;
  today: boolean;
  chips: Occurrence[];
  more: number;
}

export interface MonthBand {
  key: string;
  automationId: string;
  startId: string;
  /** Week row 0 to 5. */
  week: number;
  /** First and last weekday column (Monday = 0) the band covers. */
  fromColumn: number;
  toColumn: number;
}

export interface MonthGrid {
  cells: MonthCell[];
  bands: MonthBand[];
}

const runsEveryDay = (start: CalendarStart) => start.kind === "schedule" && start.schedule.type === "daily" && start.schedule.weekdays.length === 7;

export function monthCells(automations: readonly CalendarAutomation[], monthAnchor: number, now: number): MonthGrid {
  const anchor = new Date(monthAnchor);
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1).getTime());
  const days = Array.from({ length: MONTH_WEEKS * 7 }, (_, index) => addDays(first, index));
  const occurrences = occurrencesIn(automations, first, addDays(first, MONTH_WEEKS * 7), now);
  const daily = new Set(automations.flatMap((automation) => automation.starts.filter(runsEveryDay).map((start) => `${automation.id}|${start.id}`)));

  const bandDays = new Map<string, Set<number>>();
  const chipsByDay = new Map<number, Occurrence[]>();
  for (const occurrence of occurrences) {
    const day = startOfDay(occurrence.at);
    const pair = `${occurrence.automationId}|${occurrence.startId}`;
    if (occurrence.kind === "scheduled" && daily.has(pair)) {
      const index = days.indexOf(day);
      const key = `${pair}|${Math.floor(index / 7)}`;
      const set = bandDays.get(key) ?? new Set<number>();
      set.add(index % 7);
      bandDays.set(key, set);
      continue;
    }
    const list = chipsByDay.get(day) ?? [];
    list.push(occurrence);
    chipsByDay.set(day, list);
  }

  const bands = [...bandDays].map(([key, columns]): MonthBand => {
    const [automationId, startId, week] = key.split("|") as [string, string, string];
    return { key, automationId, startId, week: Number(week), fromColumn: Math.min(...columns), toColumn: Math.max(...columns) };
  }).sort((left, right) => left.week - right.week || left.key.localeCompare(right.key));
  const today = startOfDay(now);
  const cells = days.map((day, index): MonthCell => {
    const list = chipsByDay.get(day) ?? [];
    const weekBands = bands.filter((band) => band.week === Math.floor(index / 7));
    const bandRows = weekBands.reduce((rows, band, row) => (band.fromColumn <= index % 7 && index % 7 <= band.toColumn ? row + 1 : rows), 0);
    const room = Math.max(0, MONTH_CHIPS_PER_DAY - bandRows);
    return { day, inMonth: new Date(day).getMonth() === anchor.getMonth(), today: day === today, chips: list.slice(0, room), more: Math.max(0, list.length - room) };
  });
  return { cells, bands };
}

/** Returns the schedule after a drag, or null when the start cannot move, nothing changes, or the drop is at or before
 * `now`. Dropping on an hour slot keeps the original minutes unless `keepMinutes` is false. */
export function moveSchedule(schedule: RoutineSchedule, fromAt: number, toAt: number, keepMinutes = true, now?: number): RoutineSchedule | null {
  if (now !== undefined && toAt <= now) return null;
  if (schedule.type === "once") return toAt === schedule.at ? null : { type: "once", at: toAt };
  if (schedule.type !== "daily") return null;
  const target = new Date(toAt);
  const minutes = keepMinutes ? schedule.time.split(":")[1] ?? "00" : String(target.getMinutes()).padStart(2, "0");
  const time = `${String(target.getHours()).padStart(2, "0")}:${minutes}`;
  const fromDay = new Date(fromAt).getDay();
  if (schedule.weekdays.length !== 7 && fromDay !== target.getDay() && schedule.weekdays.includes(target.getDay())) return null;
  const weekdays = schedule.weekdays.length === 7
    ? schedule.weekdays
    : schedule.weekdays.map((day) => (day === fromDay ? target.getDay() : day)).sort((left, right) => left - right);
  if (time === schedule.time && weekdays.join(",") === [...schedule.weekdays].sort((left, right) => left - right).join(",")) return null;
  return { type: "daily", time, weekdays };
}

export interface SchedulePhrase {
  /** Weekdays (Sunday = 0), or "all" for every day. A one-time schedule gives its own weekday. */
  days: number[] | "all";
  /** 24-hour "HH:MM". */
  time: string;
  /** A one-time schedule's day; absent for a repeating one. */
  date?: number;
}

export function shortSchedule(schedule: RoutineSchedule): SchedulePhrase | null {
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return { days: [at.getDay()], time: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, date: startOfDay(schedule.at) };
  }
  if (schedule.type !== "daily") return null;
  return { days: schedule.weekdays.length === 7 ? "all" : [...schedule.weekdays].sort((left, right) => left - right), time: schedule.time };
}
