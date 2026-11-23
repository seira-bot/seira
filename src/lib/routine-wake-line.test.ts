import { describe, expect, it } from "vitest";
import { routineWakeLine } from "./routine-wake-line";

const names = [{ id: "r1", name: "Morning report" }];
const wake = { keepAwake: true, hold: true, reason: "running", at: null, routineId: "r1" };

describe("routineWakeLine", () => {
  it("names the automation that is working", () => {
    expect(routineWakeLine(wake, names)).toBe("Keeps this computer awake while Morning report works.");
  });

  it("names the automation and the time when a run is due", () => {
    const line = routineWakeLine({ ...wake, reason: "due", at: Date.UTC(2026, 10, 24, 9, 0) }, names);
    expect(line).toMatch(/^Keeps this computer awake until .+ for Morning report\.$/);
  });

  it("shows nothing when the name is unknown, nothing holds, or the switch is off", () => {
    expect(routineWakeLine({ ...wake, routineId: "other" }, names)).toBeNull();
    expect(routineWakeLine({ ...wake, hold: false }, names)).toBeNull();
    expect(routineWakeLine({ ...wake, keepAwake: false }, names)).toBeNull();
    expect(routineWakeLine({ ...wake, routineId: null }, names)).toBeNull();
    expect(routineWakeLine({ ...wake, reason: "due", at: null }, names)).toBeNull();
  });
});
