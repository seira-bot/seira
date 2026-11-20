// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowRun, WorkflowStep, WorkflowStepRun } from "../../../shared/workflows";
import { WorkflowRunSteps } from "./WorkflowRunSteps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const names: Record<string, string> = { "bot-a": "Scout" };
const botName = (id: string) => names[id];
const chain = (count: number): { steps: WorkflowStep[]; connections: WorkflowRun["graph"]["connections"] } => ({
  steps: Array.from({ length: count }, (_, index): WorkflowStep => ({ id: `s${index + 1}`, kind: "bot", botId: "bot-a", instruction: `Do ${index + 1}`, position: { x: 0, y: index * 160 } })),
  connections: Array.from({ length: count - 1 }, (_, index) => ({ id: `c${index + 1}`, from: `s${index + 1}`, to: `s${index + 2}` })),
});
const makeRun = (count: number, stepRuns: WorkflowStepRun[], status: WorkflowRun["status"] = "active"): WorkflowRun => ({
  runId: "run-1", workflowId: "wf1", routineId: "r1", workflowName: "Round", status, graph: chain(count), botIds: ["bot-a"], startStepId: "s1", threads: {}, stepRuns, createdAt: 1, updatedAt: 1,
});

let root: Root | null = null;
function mount(run: WorkflowRun, onOpen = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(WorkflowRunSteps, { run, botName, onOpen })));
  return { container, onOpen };
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the steps of a run", () => {
  it("lists the steps in order with a status word and an icon for each", () => {
    const { container } = mount(makeRun(3, [{ stepId: "s1", status: "done" }, { stepId: "s2", status: "failed", errorCode: "turn_failed" }]));
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.getAttribute("data-step-status"))).toEqual(["done", "failed", "not_started"]);
    expect(rows.map((row) => row.querySelector(":scope > span:last-child")?.textContent)).toEqual(["Done", "Failed", "Not started"]);
    for (const row of rows) expect(row.querySelector("svg")).not.toBeNull();
    expect(rows[0]!.textContent).toContain("Scout");
  });

  it("folds a long run behind a count, keeping the failed or working step in view", () => {
    const done = [1, 2, 3, 4].map((n): WorkflowStepRun => ({ stepId: `s${n}`, status: "done" }));
    const { container } = mount(makeRun(8, [...done, { stepId: "s5", status: "running" }]));
    const folded = container.querySelector("details")!;
    expect(folded.querySelector("summary")?.textContent).toBe("4 more steps");
    expect(folded.querySelectorAll("li")).toHaveLength(4);
    const outside = [...container.querySelectorAll("li")].filter((row) => !folded.contains(row));
    expect(outside.map((row) => row.getAttribute("data-step-status"))).toEqual(["done", "done", "done", "running"]);
  });

  it("counts one folded step in the singular", () => {
    const { container } = mount(makeRun(7, [{ stepId: "s1", status: "done" }, { stepId: "s2", status: "done" }, { stepId: "s3", status: "done" }, { stepId: "s5", status: "failed", errorCode: "turn_failed" }, { stepId: "s6", status: "running" }, { stepId: "s7", status: "waiting" }]));
    expect(container.querySelector("details summary")?.textContent).toBe("1 more step");
    expect(container.querySelector("details li")?.textContent).toContain("Not started");
  });

  it("opens the run view with Open", () => {
    const { container, onOpen } = mount(makeRun(2, []));
    expect(container.querySelector("[data-workflow-run=run-1]")).not.toBeNull();
    const open = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Open")!;
    act(() => { open.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
