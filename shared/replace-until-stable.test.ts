import { describe, expect, it } from "vitest";

import { replaceUntilStable } from "./replace-until-stable.ts";

describe("replaceUntilStable", () => {
  it("removes a match that forms once an inner match is gone", () => {
    expect(replaceUntilStable("<<b>b>", /<b>/g, "")).toBe("");
    expect(replaceUntilStable("<!<!-- x -->-- y -->", /<!--[\s\S]*?-->/g, "")).toBe("");
  });

  it("leaves text without a match as it was", () => {
    expect(replaceUntilStable("plain text", /<[^>]+>/g, "")).toBe("plain text");
  });

  it("finishes at once on a long input", () => {
    const text = "<a>".repeat(100_000);
    const started = performance.now();
    expect(replaceUntilStable(text, /<[^>]+>/g, "")).toBe("");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
