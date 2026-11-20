import { describe, expect, it } from "vitest";

import { formatRowTime } from "./sidebar-row-time";

const now = new Date(2026, 10, 19, 15, 0).getTime();
const at = (day: number, hour = 14, minute = 31) => new Date(2026, 10, day, hour, minute).getTime();

describe("formatRowTime", () => {
  it("shows the clock for today", () => {
    expect(formatRowTime(at(19), now)).toBe("2:31 PM");
  });

  it("says Yesterday for the day before", () => {
    expect(formatRowTime(at(18, 23, 59), now)).toBe("Yesterday");
  });

  it("shows the weekday for the rest of the week", () => {
    expect(formatRowTime(at(16), now)).toBe("Mon");
  });

  it("shows a short date for older rows", () => {
    expect(formatRowTime(at(5), now)).toBe("Nov 5");
  });
});
