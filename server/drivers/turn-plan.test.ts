import { describe, expect, it } from "vitest";

import { acpTurnPlan, claudeTodoPlan, codexTurnPlan, planCounts } from "./turn-plan.ts";

const todos = (...statuses: string[]) => ({ todos: statuses.map((status, i) => ({ content: `task ${i}`, status, activeForm: `doing ${i}` })) });
const steps = (...statuses: string[]) => ({ plan: statuses.map((status, i) => ({ step: `step ${i}`, status })) });

describe("claudeTodoPlan", () => {
  it("counts the completed items of a TodoWrite list", () => {
    expect(claudeTodoPlan(todos("pending", "pending", "pending"))).toEqual({ type: "turn.plan", done: 0, total: 3 });
    expect(claudeTodoPlan(todos("completed", "in_progress", "pending", "completed"))).toEqual({ type: "turn.plan", done: 2, total: 4 });
    expect(claudeTodoPlan(todos("completed", "completed"))).toEqual({ type: "turn.plan", done: 2, total: 2 });
  });

  it("sends nothing for an empty list", () => {
    expect(claudeTodoPlan({ todos: [] })).toBeNull();
  });

  it("caps a long list at 50 items", () => {
    const sixty = todos(...Array.from({ length: 60 }, (_, i) => (i < 55 ? "completed" : "pending")));
    expect(claudeTodoPlan(sixty)).toEqual({ type: "turn.plan", done: 50, total: 50 });
    expect(claudeTodoPlan(todos(...Array.from({ length: 60 }, () => "pending")))).toEqual({ type: "turn.plan", done: 0, total: 50 });
  });

  it("sends nothing for a shape it does not know, and skips entries that are not objects", () => {
    for (const bad of [undefined, null, "todos", 7, [], {}, { todos: "x" }, { todos: { 0: { status: "completed" } } }, { todos: [null, "completed", 3, ["completed"]] }]) {
      expect(claudeTodoPlan(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(claudeTodoPlan({ todos: [{ status: "completed" }, "completed", null, {}] })).toEqual({ type: "turn.plan", done: 1, total: 2 });
  });

  it("carries the two counts and no task text", () => {
    const plan = claudeTodoPlan({ todos: [{ content: "SECRET_TASK_TEXT", status: "completed", activeForm: "SECRET_FORM" }] });
    expect(Object.keys(plan ?? {}).sort()).toEqual(["done", "total", "type"]);
    expect(JSON.stringify(plan)).not.toContain("SECRET");
  });
});

describe("codexTurnPlan", () => {
  it("counts the completed steps, and not the one in progress", () => {
    expect(codexTurnPlan(steps("completed", "inProgress", "pending"))).toEqual({ type: "turn.plan", done: 1, total: 3 });
    expect(codexTurnPlan({ ...steps("pending"), explanation: "why", threadId: "t" })).toEqual({ type: "turn.plan", done: 0, total: 1 });
  });

  it("sends nothing for an empty or unknown plan", () => {
    for (const bad of [undefined, null, {}, { plan: [] }, { plan: "x" }]) expect(codexTurnPlan(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("acpTurnPlan", () => {
  const entries = (...statuses: string[]) => ({ sessionUpdate: "plan", entries: statuses.map((status, i) => ({ content: `entry ${i}`, priority: "medium", status })) });

  it("counts the completed entries of a plan update", () => {
    expect(acpTurnPlan(entries("completed", "in_progress", "pending"))).toEqual({ type: "turn.plan", done: 1, total: 3 });
    expect(acpTurnPlan(entries("completed", "completed"))).toEqual({ type: "turn.plan", done: 2, total: 2 });
  });

  it("sends nothing for an empty or unknown plan", () => {
    for (const bad of [undefined, null, {}, { entries: [] }, { entries: "x" }]) expect(acpTurnPlan(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("planCounts", () => {
  it("keeps done at or under total", () => {
    const list = Array.from({ length: 120 }, () => ({ done: true }));
    expect(planCounts(list, (item) => item.done === true)).toEqual({ type: "turn.plan", done: 50, total: 50 });
  });
});
