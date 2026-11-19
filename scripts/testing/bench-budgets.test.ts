import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { budgetExitCode, checkBudgets, DEFAULT_BUDGETS_FILE, formatReport, loadBudgets, parseBudgets, parseKinds, readPointer, type Budget } from "./bench-budgets.ts";

const PHASES = ["bundle", "server", "start", "screens", "idle", "stream", "big", "routines"];
const budgets: Budget[] = [
  { metric: "/big/stream/componentsRenderedPerCommit", max: 80, kind: "count" },
  { metric: "/big/load/longestTaskMs", max: 1000, kind: "time" },
  { metric: "/server/bundleRssMb/at30s", max: 300, kind: "memory" },
];

describe("checkBudgets", () => {
  it("passes when every value is within its limit", () => {
    const result = { big: { stream: { componentsRenderedPerCommit: 80 }, load: { longestTaskMs: 458 } }, server: { bundleRssMb: { at30s: 173 } } };
    const report = checkBudgets(result, budgets);
    expect(report.failed).toEqual([]);
    expect(report.passed).toHaveLength(3);
    expect(budgetExitCode(report)).toBe(0);
  });

  it("fails above the limit and names the metric, the value and the limit", () => {
    const result = { big: { stream: { componentsRenderedPerCommit: 99 }, load: { longestTaskMs: 458 } }, server: { bundleRssMb: { at30s: 173 } } };
    const report = checkBudgets(result, budgets);
    expect(report.failed).toEqual([{ ...budgets[0], value: 99, reason: "above" }]);
    const text = formatReport(report);
    expect(text).toContain("/big/stream/componentsRenderedPerCommit");
    expect(text).toContain("99");
    expect(text).toContain("80");
    expect(text).toContain("count");
    expect(text).toContain("1 failed");
    expect(budgetExitCode(report)).toBe(1);
  });

  it("skips the budgets of a phase that did not run", () => {
    const report = checkBudgets({ server: { bundleRssMb: { at30s: 173 } } }, budgets);
    expect(report.skipped.map((entry) => entry.metric)).toEqual([budgets[0]!.metric, budgets[1]!.metric]);
    expect(report.failed).toEqual([]);
  });

  it("fails a missing metric in a phase that ran", () => {
    const report = checkBudgets({ big: {}, server: { bundleRssMb: { at30s: "n/a" } } }, budgets);
    expect(report.failed.map((entry) => [entry.metric, entry.reason])).toEqual([
      [budgets[0]!.metric, "missing"],
      [budgets[1]!.metric, "missing"],
      [budgets[2]!.metric, "missing"],
    ]);
    expect(formatReport(report)).toContain("missing");
  });

  it("reads a key that contains a slash through the JSON Pointer escape", () => {
    const result = { big: { "a/b": { "c~d": 7 } } };
    expect(readPointer(result, "/big/a~1b/c~0d")).toBe(7);
    const report = checkBudgets(result, [{ metric: "/big/a~1b/c~0d", max: 5, kind: "count" }]);
    expect(report.failed[0]?.value).toBe(7);
  });

  it("checks only the requested kinds", () => {
    const result = { big: { stream: { componentsRenderedPerCommit: 99 }, load: { longestTaskMs: 5000 } }, server: { bundleRssMb: { at30s: 1 } } };
    const report = checkBudgets(result, budgets, parseKinds("count,memory"));
    expect(report.failed.map((entry) => entry.kind)).toEqual(["count"]);
    expect(report.skipped.map((entry) => entry.kind)).toEqual(["time"]);
    expect(() => parseKinds("speed")).toThrow(/unknown budget kind/);
  });
});

describe("budgets file", () => {
  it("rejects a bad shape with a clear error", () => {
    expect(() => parseBudgets("{")).toThrow(/not valid JSON/);
    expect(() => parseBudgets("{}")).toThrow(/"budgets" array/);
    expect(() => parseBudgets('{"budgets":[{"metric":"big/x","max":1,"kind":"count"}]}')).toThrow(/JSON Pointer/);
    expect(() => parseBudgets('{"budgets":[{"metric":"/big/x","max":"1","kind":"count"}]}')).toThrow(/numeric "max"/);
    expect(() => parseBudgets('{"budgets":[{"metric":"/big/x","max":1,"kind":"speed"}]}')).toThrow(/"kind"/);
    expect(() => parseBudgets('{"budgets":[{"metric":"/big/x","max":1,"kind":"time"},{"metric":"/big/x","max":2,"kind":"time"}]}')).toThrow(/repeats/);
  });

  it("loads the committed budgets, each in a bench phase", () => {
    const loaded = loadBudgets(DEFAULT_BUDGETS_FILE);
    expect(loaded.length).toBeGreaterThan(0);
    for (const budget of loaded) expect(PHASES).toContain(budget.metric.split("/")[1]);
    expect(JSON.parse(readFileSync(DEFAULT_BUDGETS_FILE, "utf8")).budgets).toHaveLength(loaded.length);
  });
});
