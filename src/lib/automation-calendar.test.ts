import { describe, expect, it } from "vitest";

import type { RoutineRun, RoutineSchedule } from "@/lib/routines";
import * as calendar from "./automation-calendar";
import {
  gridHours, monthCells, moveSchedule, occurrencesIn, shortSchedule,
  type CalendarAutomation, type CalendarStart,
} from "./automation-calendar";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 27, 18, 40); // Friday
const WEEK = at(2026, 11, 23); // Monday of that week
const ALL = [0, 1, 2, 3, 4, 5, 6];

const schedule = (id: string, value: RoutineSchedule, extra: Partial<Extract<CalendarStart, { kind: "schedule" }>> = {}): CalendarStart => ({ id, kind: "schedule", schedule: value, enabled: true, ...extra });
let sequence = 0;
const run = (routineId: string, scheduledFor: number, status: RoutineRun["status"] = "completed", extra: Partial<RoutineRun> = {}): RoutineRun => ({
  id: `run-${++sequence}`, routineId, routineName: "x", target: "bot", botId: "scout", runOn: "seira", scheduledFor, startedAt: scheduledFor,
  createdAt: scheduledFor, status, manual: false, ...extra,
});
const automation = (id: string, starts: CalendarStart[], extra: Partial<CalendarAutomation> = {}): CalendarAutomation => ({
  id, name: id, enabled: true, draft: false, manual: false, needsYou: false, statusLine: "", starts, stepBotIds: ["scout"], runs: [], ...extra,
});
const daily = (id: string, time: string, weekdays = ALL) => schedule(id, { type: "daily", time, weekdays });
const times = (list: { at: number }[]) => list.map((item) => item.at);

describe("occurrencesIn", () => {
  it("gives future occurrences only, from the later of now and the range start", () => {
    const list = occurrencesIn([automation("a", [daily("s", "09:00")])], WEEK, WEEK + 7 * 86_400_000, NOW);
    expect(times(list)).toEqual([at(2026, 11, 28, 9), at(2026, 11, 29, 9)]);
    expect(list.every((item) => item.kind === "scheduled")).toBe(true);
    expect(list[0]!.key).toBe(`a|s|${at(2026, 11, 28, 9)}`);
  });

  it("gives nothing in the future for a paused automation or a paused start", () => {
    const range = [WEEK, WEEK + 7 * 86_400_000] as const;
    expect(occurrencesIn([automation("a", [daily("s", "09:00")], { enabled: false })], ...range, NOW)).toEqual([]);
    expect(occurrencesIn([automation("a", [{ id: "s", kind: "schedule", schedule: { type: "daily", time: "09:00", weekdays: ALL }, enabled: false }])], ...range, NOW)).toEqual([]);
  });

  it("shows a past run of a schedule start as a past run with its status", () => {
    const runs = [
      run("s", at(2026, 11, 26, 9), "failed"), run("s", at(2026, 11, 25, 9), "completed"), run("s", at(2026, 11, 24, 9), "running"),
      run("s", at(2026, 11, 23, 9), "completed", { skipped: { count: 1, firstAt: 0, lastAt: 0 } }),
    ];
    const list = occurrencesIn([automation("a", [daily("s", "09:00")], { runs })], WEEK, WEEK + 7 * 86_400_000, NOW);
    const past = list.filter((item) => item.kind === "past-run");
    expect(past.map((item) => item.runStatus)).toEqual(["skipped", "running", "done", "failed"]);
  });

  it("does not repeat a time that already has a run", () => {
    const runs = [run("s", at(2026, 11, 28, 9), "queued")];
    const list = occurrencesIn([automation("a", [daily("s", "09:00")], { runs })], WEEK, WEEK + 7 * 86_400_000, NOW);
    expect(times(list.filter((item) => item.kind === "scheduled"))).toEqual([at(2026, 11, 29, 9)]);
  });

  it("shows webhook and app runs as app runs and never makes future cards from them", () => {
    const starts: CalendarStart[] = [{ id: "h", kind: "webhook" }, { id: "g", kind: "app", app: "gmail" }];
    const runs = [run("g", at(2026, 11, 26, 14), "completed"), run("h", at(2026, 11, 27, 8), "failed"), run("h", at(2026, 11, 28, 8), "queued")];
    const list = occurrencesIn([automation("a", starts, { runs })], WEEK, WEEK + 7 * 86_400_000, NOW);
    expect(list.map((item) => [item.kind, item.runStatus, item.startId])).toEqual([["app-run", "done", "g"], ["app-run", "failed", "h"]]);
  });

  it("marks each scheduled time before now with no run as missed when the automation needs the person", () => {
    const runs = [run("s", at(2026, 11, 24, 9), "completed")];
    const list = occurrencesIn([automation("a", [daily("s", "09:00", [1, 2, 3])], { needsYou: true, runs })], WEEK, WEEK + 7 * 86_400_000, NOW);
    expect(list.map((item) => [item.kind, item.at])).toEqual([["missed", at(2026, 11, 23, 9)], ["past-run", at(2026, 11, 24, 9)], ["missed", at(2026, 11, 25, 9)]]);
    const quiet = occurrencesIn([automation("a", [daily("s", "09:00", [1, 2, 3])], { runs })], WEEK, WEEK + 7 * 86_400_000, NOW);
    expect(quiet.some((item) => item.kind === "missed")).toBe(false);
  });

  it("shows a run with the missed status as missed", () => {
    const list = occurrencesIn([automation("a", [daily("s", "09:00")], { runs: [run("s", at(2026, 11, 26, 9), "missed")] })], WEEK, WEEK + 7 * 86_400_000, NOW);
    expect(list.find((item) => item.at === at(2026, 11, 26, 9))!.kind).toBe("missed");
  });

  it("does not put a missed mark before the start was created", () => {
    const created = schedule("s", { type: "daily", time: "09:00", weekdays: ALL }, { createdAt: at(2026, 11, 25, 12) });
    const list = occurrencesIn([automation("a", [created], { needsYou: true })], WEEK, NOW, NOW);
    expect(times(list)).toEqual([at(2026, 11, 26, 9), at(2026, 11, 27, 9)]);
  });

  it("flags multi for an automation with two or more schedule starts", () => {
    const two = occurrencesIn([automation("a", [daily("s1", "09:00"), daily("s2", "10:00")])], NOW, NOW + 86_400_000, NOW);
    expect(two.length).toBe(2);
    expect(two.every((item) => item.multi)).toBe(true);
    const one = occurrencesIn([automation("b", [daily("s1", "09:00"), { id: "w", kind: "webhook" }])], NOW, NOW + 86_400_000, NOW);
    expect(one.every((item) => !item.multi)).toBe(true);
  });

  it("lets a future card move only for a once or a daily schedule", () => {
    const starts = [
      schedule("once", { type: "once", at: at(2026, 11, 28, 8) }),
      daily("daily", "09:00"),
      schedule("cron", { type: "cron", expression: "0 10 * * *", timeZone: "UTC" }),
      schedule("interval", { type: "interval", everyMinutes: 60, anchorAt: NOW }, { nextRunAt: at(2026, 11, 28, 11) }),
    ];
    const list = occurrencesIn([automation("a", starts)], at(2026, 11, 28), at(2026, 11, 29), NOW);
    const byStart = Object.fromEntries(list.filter((item) => item.kind === "scheduled").map((item) => [item.startId, item.canMove]));
    expect(byStart).toEqual({ once: true, daily: true, cron: false, interval: false });
    const past = occurrencesIn([automation("a", [daily("daily", "09:00")], { runs: [run("daily", at(2026, 11, 26, 9))] })], WEEK, NOW, NOW);
    expect(past.every((item) => !item.canMove)).toBe(true);
  });

  it("expands a cron start and a limit reset through its next run", () => {
    const starts = [
      schedule("cron", { type: "cron", expression: "0 10 * * *", timeZone: "UTC" }),
      schedule("reset", { type: "limit_reset", engine: "claude", repeat: "once", at: null }, { nextRunAt: at(2026, 11, 29, 6) }),
    ];
    const list = occurrencesIn([automation("a", starts)], at(2026, 11, 28), at(2026, 11, 30), NOW);
    expect(list.filter((item) => item.startId === "cron").length).toBe(2);
    expect(times(list.filter((item) => item.startId === "reset"))).toEqual([at(2026, 11, 29, 6)]);
  });

  it("shows a weekly cron start once in a week range", () => {
    const starts = [schedule("cron", { type: "cron", expression: "0 10 * * 3", timeZone: "UTC" })];
    const list = occurrencesIn([automation("a", starts)], at(2026, 11, 30), at(2026, 12, 7), NOW);
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe("scheduled");
  });

  it("shows a monthly cron start in a month range", () => {
    const starts = [schedule("cron", { type: "cron", expression: "0 10 28 * *", timeZone: "UTC" })];
    const grid = monthCells([automation("a", starts)], at(2026, 11, 15), NOW);
    expect(grid.cells.flatMap((cell) => cell.chips)).toHaveLength(1);
  });

  it("keeps the later cards of a dense cron start", () => {
    const starts = [schedule("cron", { type: "cron", expression: "*/30 * * * *", timeZone: "UTC" })];
    const list = occurrencesIn([automation("a", starts)], at(2026, 11, 28), at(2026, 11, 29), NOW);
    expect(list.length).toBe(48);
    expect(list.some((item) => item.at >= at(2026, 11, 28, 6))).toBe(true);
  });

  it("starts a cron start no earlier than its next run", () => {
    const starts = [schedule("cron", { type: "cron", expression: "0 10 * * *", timeZone: "UTC" }, { nextRunAt: at(2026, 11, 30, 0) })];
    const list = occurrencesIn([automation("a", starts)], at(2026, 11, 28), at(2026, 12, 2), NOW);
    expect(list.every((item) => item.at >= at(2026, 11, 30, 0))).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it("sorts every occurrence by time", () => {
    const list = occurrencesIn([automation("a", [daily("s1", "15:00")]), automation("b", [daily("s2", "07:00")])], NOW, NOW + 3 * 86_400_000, NOW);
    expect(times(list)).toEqual([...times(list)].sort((left, right) => left - right));
  });
});

describe("gridHours", () => {
  it("shows 07:00 to 22:00 with both empty rows by default", () => {
    expect(gridHours([{ at: at(2026, 11, 28, 9) }])).toEqual({ start: 7, end: 22, before: true, after: true });
    expect(gridHours([{ at: at(2026, 11, 28, 7, 0) }, { at: at(2026, 11, 28, 21, 59) }])).toEqual({ start: 7, end: 22, before: true, after: true });
  });

  it("extends to the hour of an occurrence outside the window", () => {
    expect(gridHours([{ at: at(2026, 11, 28, 5, 30) }])).toEqual({ start: 5, end: 22, before: false, after: true });
    expect(gridHours([{ at: at(2026, 11, 28, 22, 0) }])).toEqual({ start: 7, end: 23, before: true, after: false });
    expect(gridHours([{ at: at(2026, 11, 28, 6, 59) }, { at: at(2026, 11, 28, 23, 30) }])).toEqual({ start: 6, end: 24, before: false, after: false });
  });
});

describe("gridHours with extra times", () => {
  it("grows the grid to show an extra time outside the window", () => {
    expect(gridHours([], [at(2026, 11, 28, 5, 30), at(2026, 11, 28, 23, 10)])).toEqual({ start: 5, end: 24, before: false, after: false });
  });
});

describe("monthCells", () => {
  const anchor = at(2026, 11, 15);

  it("builds 6 weeks from Monday, marks today and the days of the month", () => {
    const { cells } = monthCells([], anchor, NOW);
    expect(cells.length).toBe(42);
    expect(cells[0]!.day).toBe(at(2026, 10, 26));
    expect(cells[0]!.inMonth).toBe(false);
    expect(cells[6]!.inMonth).toBe(true);
    expect(cells.filter((cell) => cell.today).map((cell) => cell.day)).toEqual([at(2026, 11, 27)]);
  });

  it("makes one band per week row for an every-day schedule instead of seven chips", () => {
    const { cells, bands } = monthCells([automation("a", [daily("s", "10:30")])], anchor, NOW);
    expect(bands.map((band) => [band.week, band.fromColumn, band.toColumn])).toEqual([[4, 5, 6], [5, 0, 6]]);
    expect(cells.every((cell) => cell.chips.length === 0)).toBe(true);
  });

  it("keeps a chip for a schedule on some weekdays", () => {
    const { cells, bands } = monthCells([automation("a", [daily("s", "10:30", [1, 3])])], anchor, NOW);
    expect(bands).toEqual([]);
    expect(cells.find((cell) => cell.day === at(2026, 12, 2))!.chips.length).toBe(1);
  });

  it("keeps at most 3 chips a day and counts the rest", () => {
    const five = Array.from({ length: 5 }, (_, index) => automation(`a${index}`, [schedule("s", { type: "once", at: at(2026, 12, 1, 8 + index) })]));
    const cell = monthCells(five, anchor, NOW).cells.find((candidate) => candidate.day === at(2026, 12, 1))!;
    expect(cell.chips.map((chip) => chip.automationId)).toEqual(["a0", "a1", "a2"]);
    expect(cell.more).toBe(2);
  });

  it("shows fewer chips under a band and counts the hidden chips in more", () => {
    const once = Array.from({ length: 3 }, (_, index) => automation(`o${index}`, [schedule("s", { type: "once", at: at(2026, 12, 1, 8 + index) })]));
    const { cells, bands } = monthCells([automation("band", [daily("d", "10:30")]), ...once], anchor, NOW);
    expect(bands.length).toBeGreaterThan(0);
    const cell = cells.find((candidate) => candidate.day === at(2026, 12, 1))!;
    expect(cell.chips).toHaveLength(2);
    expect(cell.more).toBe(1);
  });
});

describe("moveSchedule", () => {
  const monday9 = at(2026, 11, 23, 9);

  it("changes only the time of an every-day schedule and keeps the minutes", () => {
    expect(moveSchedule({ type: "daily", time: "10:30", weekdays: ALL }, at(2026, 11, 28, 10, 30), at(2026, 11, 29, 14))).toEqual({ type: "daily", time: "14:30", weekdays: ALL });
  });

  it("takes the minutes of the drop when keepMinutes is false", () => {
    expect(moveSchedule({ type: "daily", time: "10:30", weekdays: ALL }, monday9, at(2026, 11, 23, 14, 15), false)).toEqual({ type: "daily", time: "14:15", weekdays: ALL });
  });

  it("replaces the dragged weekday and sets the hour for a schedule on some weekdays", () => {
    expect(moveSchedule({ type: "daily", time: "09:00", weekdays: [1] }, monday9, at(2026, 11, 24, 10))).toEqual({ type: "daily", time: "10:00", weekdays: [2] });
    expect(moveSchedule({ type: "daily", time: "09:00", weekdays: [1, 5] }, monday9, at(2026, 11, 26, 9))).toEqual({ type: "daily", time: "09:00", weekdays: [4, 5] });
  });

  it("refuses a drop on a weekday the schedule already uses", () => {
    expect(moveSchedule({ type: "daily", time: "09:00", weekdays: [1, 5] }, monday9, at(2026, 11, 27, 9))).toBeNull();
  });

  it("sets the new time of a one-time schedule", () => {
    expect(moveSchedule({ type: "once", at: monday9 }, monday9, at(2026, 11, 30, 11, 15))).toEqual({ type: "once", at: at(2026, 11, 30, 11, 15) });
  });

  it("refuses a drop at or before now for a one-time and a daily schedule", () => {
    const future = at(2026, 11, 28, 9);
    expect(moveSchedule({ type: "once", at: future }, future, NOW, true, NOW)).toBeNull();
    expect(moveSchedule({ type: "once", at: future }, future, NOW - 3_600_000, true, NOW)).toBeNull();
    expect(moveSchedule({ type: "daily", time: "09:00", weekdays: ALL }, future, at(2026, 11, 27, 9), true, NOW)).toBeNull();
    expect(moveSchedule({ type: "once", at: future }, future, NOW + 3_600_000, true, NOW)).toEqual({ type: "once", at: NOW + 3_600_000 });
  });

  it("returns null for cron, limit reset, interval and an unchanged slot", () => {
    expect(moveSchedule({ type: "cron", expression: "0 9 * * *", timeZone: "UTC" }, monday9, monday9 + 3_600_000)).toBeNull();
    expect(moveSchedule({ type: "interval", everyMinutes: 30, anchorAt: monday9 }, monday9, monday9 + 3_600_000)).toBeNull();
    expect(moveSchedule({ type: "limit_reset", engine: "claude", repeat: "once", at: monday9 }, monday9, monday9 + 3_600_000)).toBeNull();
    expect(moveSchedule({ type: "daily", time: "09:00", weekdays: [1] }, monday9, at(2026, 11, 23, 9, 45))).toBeNull();
    expect(moveSchedule({ type: "daily", time: "09:00", weekdays: ALL }, monday9, at(2026, 11, 24, 9))).toBeNull();
    expect(moveSchedule({ type: "once", at: monday9 }, monday9, monday9)).toBeNull();
  });
});

describe("shortSchedule", () => {
  it("gives structured parts for the ghost card and the toast", () => {
    expect(shortSchedule({ type: "daily", time: "10:30", weekdays: ALL })).toEqual({ days: "all", time: "10:30" });
    expect(shortSchedule({ type: "daily", time: "10:00", weekdays: [2] })).toEqual({ days: [2], time: "10:00" });
    expect(shortSchedule({ type: "daily", time: "10:00", weekdays: [3, 1] })).toEqual({ days: [1, 3], time: "10:00" });
    expect(shortSchedule({ type: "once", at: at(2026, 11, 30, 8, 5) })).toEqual({ days: [1], time: "08:05", date: at(2026, 11, 30) });
    expect(shortSchedule({ type: "interval", everyMinutes: 30, anchorAt: 0 })).toBeNull();
  });
});

describe("timing", () => {
  it("builds the occurrences and cells of one month for 50 automations in under 50 ms", () => {
    const many = Array.from({ length: 50 }, (_, index) => automation(`a${index}`, [
      daily(`d${index}`, `${String(7 + (index % 12)).padStart(2, "0")}:00`, index % 2 ? ALL : [1, 3, 5]),
      schedule(`o${index}`, { type: "once", at: at(2026, 12, 1 + (index % 20), 9) }),
    ], { runs: [run(`d${index}`, at(2026, 11, 20, 9))] }));
    const month = () => {
      const grid = monthCells(many, at(2026, 11, 15), NOW);
      occurrencesIn(many, at(2026, 10, 26), at(2026, 12, 7), NOW);
      return grid;
    };
    month();
    const started = performance.now();
    month();
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("exports", () => {
  it("has one name for the short schedule phrase", () => {
    expect(Object.keys(calendar)).not.toContain("scheduleSentenceAfterMove");
    expect(Object.keys(calendar)).toContain("shortSchedule");
  });
});
