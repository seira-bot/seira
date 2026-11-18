import { describe, expect, it } from "vitest";

import { FULL_FRAME_MS, SMALL_MASCOT_PX, frameFloorMs, nextFrameAt } from "./mascot-motion";

describe("mascot cadence", () => {
  it("puts every tier on one 60 Hz grid so mascots on different phases draw in the same frame", () => {
    expect(nextFrameAt(1003, 50)).toBe(nextFrameAt(1011, 50));
    expect(nextFrameAt(1003, 50) - 1003).toBeGreaterThanOrEqual(40);
    expect(nextFrameAt(1001, FULL_FRAME_MS)).toBe(nextFrameAt(1008, FULL_FRAME_MS));
    for (const interval of [50, 1000 / 30, FULL_FRAME_MS]) {
      const ticks = nextFrameAt(5_000, interval) / FULL_FRAME_MS;
      expect(Math.abs(ticks - Math.round(ticks))).toBeLessThan(1e-9);
    }
  });

  it("draws small mascots at most 20 times a second and larger ones at full rate", () => {
    expect(frameFloorMs(SMALL_MASCOT_PX)).toBe(50);
    expect(frameFloorMs(SMALL_MASCOT_PX + 1)).toBeCloseTo(FULL_FRAME_MS);
  });
});
