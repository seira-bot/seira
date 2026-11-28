import { expect, it } from "vitest";
import { compactBudget, compactionReading, contextWindowFor, contextWindowSource, shouldCompact, DEFAULT_CONTEXT_WINDOW } from "./context-budget.ts";

it("keeps compaction reachable below small model windows", () => {
  expect(compactBudget(8_000)).toBe(6_400);
  expect(compactBudget(2_000, 20_000)).toBe(1_800);
  expect(compactBudget(100_000, 0.7, 50_000)).toBe(45_000);
});

it("rejects invalid window values and ignores invalid provider readings", () => {
  for (const value of [NaN, Infinity, 0, -1]) {
    expect(() => compactBudget(value)).toThrow();
    expect(contextWindowFor(undefined, undefined, value)).toBe(DEFAULT_CONTEXT_WINDOW);
  }
});

it("prefers measured context, and otherwise estimates without using summed tool-round input", () => {
  expect(shouldCompact({ contextTokens: 1_000, estimatedBytes: 80_000, budget: 8_000, window: 10_000 })).toBe(false);
  expect(shouldCompact({ estimatedBytes: 40_000, budget: 8_000, window: 10_000 })).toBe(true);
});

it("does not let the regrowth floor defer compaction past window headroom", () => {
  expect(shouldCompact({ contextTokens: 9_000, estimatedBytes: 0, budget: 8_000, floor: 8_500, window: 10_000 })).toBe(true);
  expect(shouldCompact({ contextTokens: 8_600, estimatedBytes: 0, budget: 8_000, floor: 8_500, window: 10_000 })).toBe(false);
});

it("does not let the regrowth floor outrun a known native compaction threshold", () => {
  const window = 1_000_000;
  const nativeCompactAt = 200_000;
  const budget = compactBudget(window, undefined, nativeCompactAt);
  expect(budget).toBe(180_000);
  expect(shouldCompact({ contextTokens: 180_000, estimatedBytes: 0, budget, floor: 175_000, window, nativeCompactAt })).toBe(true);
  expect(shouldCompact({ contextTokens: 179_999, estimatedBytes: 0, budget, floor: 175_000, window, nativeCompactAt })).toBe(false);
});

it("times compaction from a driver's reading unless the driver reports it for the meter only", () => {
  const reading = { tokens: 190_000, window: 200_000 };
  // Claude and Codex: the reading is what compaction acts on.
  expect(compactionReading({}, reading)).toBe(reading);
  expect(compactionReading(undefined, reading)).toBe(reading);
  // ACP agents: shown on the meter only.
  expect(compactionReading({ contextReading: "meter" }, reading)).toBeUndefined();
  expect(compactionReading({ contextReading: "meter" }, undefined)).toBeUndefined();
  const window = contextWindowFor("unknown-model", undefined, compactionReading({ contextReading: "meter" }, reading)?.window);
  expect(window).toBe(DEFAULT_CONTEXT_WINDOW);
  expect(shouldCompact({ contextTokens: compactionReading({ contextReading: "meter" }, reading)?.tokens, estimatedBytes: 4_000,
    budget: compactBudget(window), window })).toBe(false);
});

it("names the source of a context window", () => {
  const catalog = { options: [{ id: "listed", contextWindow: 64_000 }] } as unknown as Parameters<typeof contextWindowFor>[1];
  expect(contextWindowSource("listed", catalog, 32_000)).toEqual({ tokens: 32_000, source: "reported" });
  expect(contextWindowSource("listed", catalog)).toEqual({ tokens: 64_000, source: "catalog" });
  expect(contextWindowSource("gpt-5")).toMatchObject({ source: "name" });
  expect(contextWindowSource("fixture", catalog)).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, source: "default" });
  for (const [model, reported] of [["listed", 32_000], ["listed", undefined], ["gpt-5", undefined], ["fixture", undefined]] as const) {
    expect(contextWindowFor(model, catalog, reported)).toBe(contextWindowSource(model, catalog, reported).tokens);
  }
});
