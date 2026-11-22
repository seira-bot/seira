import { describe, expect, it } from "vitest";

import { freePortBlock } from "./ports.ts";

describe("freePortBlock", () => {
  it("returns a base inside the asked range", async () => {
    const base = await freePortBlock([0, 1], 19_600, 3_000);
    expect(base).toBeGreaterThanOrEqual(19_600);
    expect(base).toBeLessThan(19_600 + 3_000 + 1);
  });

  it("keeps a narrow range as it was given", async () => {
    expect(await freePortBlock([0], 19_600, 1)).toBe(19_600);
  });
});
