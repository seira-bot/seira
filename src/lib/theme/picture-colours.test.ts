import { describe, expect, it } from "vitest";

import { quantizeColours } from "./picture-colours";

function pixels(parts: Array<[number, number, number, number, number]>): Uint8ClampedArray {
  const total = parts.reduce((sum, part) => sum + part[4], 0);
  const out = new Uint8ClampedArray(total * 4);
  let at = 0;
  for (const [r, g, b, a, n] of parts) for (let i = 0; i < n; i++, at += 4) out.set([r, g, b, a], at);
  return out;
}

describe("quantizeColours", () => {
  it("returns the main colours, the most common first", () => {
    const colours = quantizeColours(pixels([[200, 40, 40, 255, 50], [30, 60, 200, 255, 30], [240, 240, 230, 255, 15], [20, 20, 20, 255, 5]]), 5);
    expect(colours).toHaveLength(4);
    expect(colours[0]).toBe("#c82828");
    expect(colours[1]).toBe("#1e3cc8");
    expect(colours[2]).toBe("#f0f0e6");
  });

  it("folds close shades into one swatch so five swatches look different", () => {
    const shades: Array<[number, number, number, number, number]> = [[200, 40, 40, 255, 20], [208, 44, 40, 255, 20], [216, 40, 44, 255, 20], [30, 60, 200, 255, 10]];
    const colours = quantizeColours(pixels(shades), 2);
    expect(colours).toHaveLength(2);
    expect(colours[1]).toBe("#1e3cc8");
  });

  it("skips see-through pixels", () => {
    expect(quantizeColours(pixels([[255, 0, 0, 0, 100], [0, 128, 0, 255, 3]]), 5)).toEqual(["#008000"]);
    expect(quantizeColours(pixels([[255, 0, 0, 0, 10]]), 5)).toEqual([]);
  });

  it("fills up to the count with the nearest shades when the picture has few colours", () => {
    const shades: Array<[number, number, number, number, number]> = [[100, 100, 100, 255, 10], [120, 100, 100, 255, 8], [100, 120, 100, 255, 6]];
    expect(quantizeColours(pixels(shades), 3)).toHaveLength(3);
  });
});
