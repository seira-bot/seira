import { describe, expect, it } from "vitest";

import { nextUnskippedOccurrence, occurrenceSkipped, routineSkipBody, skipRefusal, withoutPastSkips, withSkip } from "./routine-skip-occurrence.ts";
import { nextOccurrence, type RoutineSchedule } from "./routine-schedules.ts";

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 19, 8, 0, 0).getTime();
const daily: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
const interval: RoutineSchedule = { type: "interval", everyMinutes: 60, anchorAt: NOW };
const cron: RoutineSchedule = { type: "cron", expression: "0 * * * *", timeZone: "UTC" };
const routine = (schedule: RoutineSchedule, more: Record<string, unknown> = {}) => ({ enabled: true, schedule, ...more });

describe("nextUnskippedOccurrence", () => {
  it.each([daily, interval, cron])("steps past one skipped time: %j", (schedule) => {
    const first = nextOccurrence(schedule, NOW)!, second = nextOccurrence(schedule, first)!;
    expect(nextUnskippedOccurrence(schedule, NOW, undefined)).toBe(first);
    expect(nextUnskippedOccurrence(schedule, NOW, [first])).toBe(second);
  });

  it("steps past several skipped times in a row and keeps the later ones", () => {
    const one = nextOccurrence(interval, NOW)!, two = one + HOUR, three = two + HOUR, four = three + HOUR;
    expect(nextUnskippedOccurrence(interval, NOW, [one, two, three])).toBe(four);
    expect(nextUnskippedOccurrence(interval, NOW, [two, three])).toBe(one);
  });

  it("ends the schedule when the skipped time is the last one", () => {
    const ends: RoutineSchedule = { type: "interval", everyMinutes: 60, anchorAt: NOW, endsAt: NOW + 2 * HOUR };
    const last = nextOccurrence(ends, NOW + HOUR)!;
    expect(nextUnskippedOccurrence(ends, NOW + HOUR, [last])).toBeNull();
  });

  it("does not loop for a list that has bad values", () => {
    expect(nextUnskippedOccurrence(daily, NOW, "no" as never)).toBe(nextOccurrence(daily, NOW));
  });
});

describe("occurrenceSkipped", () => {
  it("finds a time in the list", () => {
    expect(occurrenceSkipped({ skippedOccurrences: [5, 9] }, 9)).toBe(true);
    expect(occurrenceSkipped({ skippedOccurrences: [5, 9] }, 6)).toBe(false);
    expect(occurrenceSkipped({}, 6)).toBe(false);
  });
});

describe("withoutPastSkips", () => {
  it("drops times that are not in the future, and returns undefined for an empty list", () => {
    expect(withoutPastSkips([1, 5, 9], 5)).toEqual([9]);
    expect(withoutPastSkips([1, 5], 5)).toBeUndefined();
    expect(withoutPastSkips(undefined, 5)).toBeUndefined();
  });
});

describe("withSkip", () => {
  it("keeps the list sorted, unique, and at most 50 times", () => {
    expect(withSkip([30, 10], 20, 0)).toEqual([10, 20, 30]);
    expect(withSkip([10], 10, 0)).toEqual([10]);
    expect(withSkip(Array.from({ length: 50 }, (_, index) => index + 1), 99, 0)).toHaveLength(50);
    expect(withSkip([1], 50, 5)).toEqual([50]);
  });
});

describe("skipRefusal", () => {
  const at = nextOccurrence(daily, NOW)! + 24 * HOUR;
  it("allows a later time that the schedule runs", () => {
    expect(skipRefusal(routine(daily), at, NOW)).toBeNull();
    expect(skipRefusal(routine(interval), nextOccurrence(interval, NOW)!, NOW)).toBeNull();
    expect(skipRefusal(routine(cron), nextOccurrence(cron, NOW)!, NOW)).toBeNull();
  });

  it("refuses a schedule that runs once, and a limit-reset schedule", () => {
    expect(skipRefusal(routine({ type: "once", at: at }), at, NOW)).toMatch(/only once/);
    expect(skipRefusal(routine({ type: "limit_reset", engine: "claude", repeat: "once", at }), at, NOW)).toMatch(/only once/);
  });

  it("refuses a time in the past, a time off the schedule, and a routine that is off", () => {
    expect(skipRefusal(routine(daily), NOW, NOW)).toMatch(/passed/);
    expect(skipRefusal(routine(daily), at + 1, NOW)).toMatch(/does not run/);
    expect(skipRefusal(routine(daily, { enabled: false }), at, NOW)).toMatch(/off/);
  });

  it("refuses a new skip when the list is full, and allows a time that is already skipped", () => {
    const full = Array.from({ length: 50 }, (_, index) => at + (index + 1) * 24 * HOUR);
    expect(skipRefusal(routine(daily, { skippedOccurrences: full }), at, NOW)).toMatch(/Too many/);
    expect(skipRefusal(routine(daily, { skippedOccurrences: full }), full[0]!, NOW)).toBeNull();
  });
});

describe("routineSkipBody", () => {
  it("accepts a whole time and a flag, and refuses anything else", () => {
    expect(routineSkipBody.safeParse({ at: 5, skip: true }).success).toBe(true);
    expect(routineSkipBody.safeParse({ at: 5.5, skip: true }).success).toBe(false);
    expect(routineSkipBody.safeParse({ at: -1, skip: true }).success).toBe(false);
    expect(routineSkipBody.safeParse({ at: 5, skip: "yes" }).success).toBe(false);
    expect(routineSkipBody.safeParse({ at: 5 }).success).toBe(false);
  });
});
