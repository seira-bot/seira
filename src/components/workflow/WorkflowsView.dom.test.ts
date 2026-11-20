// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workflow, WorkflowRun, WorkflowStep } from "../../../shared/workflows";
import type { Bot } from "@/state/store";
import { resetWorkflowsForTest } from "@/state/workflows";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));

const { WorkflowsView } = await import("./WorkflowsView");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scout = { id: "bot-a", name: "Scout", hidden: false, messages: [] } as unknown as Bot;
const ledger = { id: "bot-b", name: "Ledger", hidden: false, messages: [] } as unknown as Bot;
const botStep = (id: string, botId: string, y: number): WorkflowStep => ({ id, kind: "bot", botId, instruction: "Do it", position: { x: 0, y } });
const morning: Workflow = {
  id: "wf1", name: "Morning round", createdAt: 1, updatedAt: 10,
  steps: [botStep("a", "bot-a", 0), botStep("b", "bot-b", 200)],
  connections: [{ id: "c1", from: "a", to: "b" }],
};
const routine = (workflowId: string) => ({ id: "r1", name: "Daily", prompt: "", workflowId });

let root: Root | null = null;
let workflows: Workflow[];
function mount(props: { workflowId?: string } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(WorkflowsView, props)));
  return container;
}
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const click = (element: Element) => act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const button = (container: ParentNode, text: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text))!;

beforeEach(() => {
  vi.useFakeTimers();
  workflows = [morning];
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
    const method = (init as { method?: string } | undefined)?.method;
    if (path === "/api/workflows" && !method) return { workflows };
    if (path === "/api/workflows" && method === "POST") {
      const body = JSON.parse((init as { body: string }).body) as Partial<Workflow>;
      return { workflow: { ...morning, ...body, id: "wf-new", updatedAt: 99 } };
    }
    return {};
  });
  fixture.state = { bots: [scout, ledger], routines: [] };
  resetWorkflowsForTest();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  document.body.querySelectorAll("[data-access-toast]").forEach((node) => node.remove());
  vi.useRealTimers();
});

describe("the Workflows view", () => {
  it("shows the empty state with one line and New workflow when there are no workflows", async () => {
    workflows = [];
    const container = mount();
    await settle();
    expect(container.textContent).toContain("You have no workflows.");
    await act(async () => { button(container, "New workflow").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/workflows", expect.objectContaining({ method: "POST" }));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "workflows", workflowId: "wf-new" });
  });

  it("lists each workflow with its steps, its bots and the routines that use it", async () => {
    fixture.state = { bots: [scout, ledger], routines: [routine("wf1")] };
    const container = mount();
    await settle();
    const row = container.querySelector("[data-workflow=wf1]")!;
    expect(row.textContent).toContain("Morning round");
    expect(row.textContent).toContain("2 steps");
    expect(row.textContent).toContain("Scout");
    expect(row.textContent).toContain("Ledger");
    expect(row.textContent).toContain("Used by Daily");
  });

  it("opens a workflow from the list and goes back with All workflows", async () => {
    const container = mount();
    await settle();
    click(container.querySelector("[data-workflow=wf1] button")!);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "workflows", workflowId: "wf1" });
    act(() => root!.render(createElement(WorkflowsView, { workflowId: "wf1" })));
    await settle();
    expect(container.querySelector("[data-workflow-canvas]")).not.toBeNull();
    click(button(container, "All workflows"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines", view: "workflows", workflowId: undefined });
  });

  it("deletes a workflow no routine uses, with Undo that makes it again", async () => {
    const container = mount({ workflowId: "wf1" });
    await settle();
    await act(async () => { button(container, "Delete workflow").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/workflows/wf1", { method: "DELETE" });
    const toast = document.body.querySelector("[data-access-toast]")!;
    expect(toast.textContent).toContain("Deleted Morning round");
    fixture.api.mockClear();
    await act(async () => { button(toast, "Undo").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    const create = fixture.api.mock.calls.find(([path, init]) => path === "/api/workflows" && (init as { method?: string } | undefined)?.method === "POST")!;
    expect(JSON.parse((create[1] as { body: string }).body)).toMatchObject({ name: "Morning round", steps: morning.steps, connections: morning.connections });
  });

  it("brings back the unsaved steps on screen when Undo makes the workflow again", async () => {
    const container = mount({ workflowId: "wf1" });
    await settle();
    click(container.querySelector("[data-workflow-palette=bot]")!);
    expect(container.querySelectorAll("[data-workflow-step]")).toHaveLength(3);
    await act(async () => { button(container, "Delete workflow").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(fixture.api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "PATCH")).toHaveLength(0);
    const toast = document.body.querySelector("[data-access-toast]")!;
    await act(async () => { button(toast, "Undo").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines", view: "workflows", workflowId: "wf-new" });
    act(() => root!.render(createElement(WorkflowsView, { workflowId: "wf-new" })));
    await settle();
    expect(container.querySelectorAll("[data-workflow-step]")).toHaveLength(3);
    expect(container.querySelector("[data-workflow-save]")?.getAttribute("data-workflow-save")).not.toBe("changed");
  });

  it("moves focus to the next step when a step is deleted, then to the canvas when none is left", async () => {
    const container = mount({ workflowId: "wf1" });
    await settle();
    const stepButton = (id: string) => container.querySelector<HTMLElement>(`[data-workflow-step="${id}"]`)!;
    act(() => { stepButton("a").focus(); });
    act(() => { stepButton("a").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })); });
    await settle();
    expect(document.activeElement).toBe(stepButton("b"));
    click(stepButton("b"));
    click(button(container, "Delete step"));
    await settle();
    expect(container.querySelector("[data-workflow-step]")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("[data-workflow-canvas]"));
  });

  it("keeps Delete workflow off with the reason, linked for screen readers, while a routine uses it", async () => {
    fixture.state = { bots: [scout, ledger], routines: [routine("wf1")] };
    const container = mount({ workflowId: "wf1" });
    await settle();
    const remove = button(container, "Delete workflow");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.hasAttribute("disabled")).toBe(false);
    const reason = container.querySelector(`#${CSS.escape(remove.getAttribute("aria-describedby")!)}`)!;
    expect(reason.textContent).toBe("A routine runs this workflow: Daily. Change what it does first.");
    fixture.api.mockClear();
    await act(async () => { remove.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("warns about an empty workflow that a routine runs, and not about one nobody uses", async () => {
    workflows = [{ ...morning, steps: [], connections: [] }];
    fixture.state = { bots: [scout, ledger], routines: [routine("wf1")] };
    const linked = mount({ workflowId: "wf1" });
    await settle();
    expect(linked.querySelector("[data-workflow-warning]")!.textContent).toContain("Daily can't run this workflow until this is fixed.");
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    resetWorkflowsForTest();
    fixture.state = { bots: [scout, ledger], routines: [] };
    const plain = mount({ workflowId: "wf1" });
    await settle();
    expect(plain.querySelector("[data-workflow-warning]")).toBeNull();
  });

  it("warns when the workflow can't run, and names the routines that use it", async () => {
    workflows = [{ ...morning, steps: [botStep("a", "bot-a", 0), botStep("b", "bot-gone", 200)] }];
    const plain = mount({ workflowId: "wf1" });
    await settle();
    expect(plain.querySelector("[data-workflow-warning]")!.textContent).toContain("It can't run.");
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    resetWorkflowsForTest();
    fixture.state = { bots: [scout, ledger], routines: [routine("wf1")] };
    const linked = mount({ workflowId: "wf1" });
    await settle();
    expect(linked.querySelector("[data-workflow-warning]")!.textContent).toContain("Daily can't run this workflow until this is fixed.");
  });

  it("shows the list with a note when the opened workflow is gone", async () => {
    const container = mount({ workflowId: "wf-missing" });
    await settle();
    expect(container.querySelector("[data-workflow-gone]")).not.toBeNull();
    expect(container.querySelector("[data-workflow=wf1]")).not.toBeNull();
  });

  it("keeps the announcement and moves focus to the new run's heading after Run again from here", async () => {
    const run = (runId: string): WorkflowRun => ({
      runId, workflowId: "wf1", routineId: "r1", workflowName: "Morning round", status: "failed", graph: { steps: morning.steps, connections: morning.connections },
      botIds: ["bot-a", "bot-b"], startStepId: "a", threads: {}, createdAt: 1, updatedAt: 1,
      stepRuns: [{ stepId: "a", status: "done" }, { stepId: "b", status: "failed", botId: "bot-b", errorCode: "turn_failed" }],
    });
    fixture.state = { bots: [scout, ledger], routines: [{ ...routine("wf1"), botId: "bot-a" }], routineRuns: [] };
    const baseApi = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
      const match = /^\/api\/workflow-runs\/(run-\d)$/.exec(String(path));
      if (match) return { run: run(match[1]!) };
      if (String(path).startsWith("/api/workflows/wf1/runs")) return { runs: [] };
      if (String(path).endsWith("/run-again")) return { run: { id: "run-2" } };
      return baseApi(path, init);
    });
    const show = (workflowRunId: string) => act(() => root!.render(createElement(WorkflowsView, { workflowId: "wf1", workflowRunId })));
    fixture.dispatch.mockImplementation((action: { type: string; workflowRunId?: string }) => {
      if (action.type === "showRoutines" && action.workflowRunId) show(action.workflowRunId);
    });
    const container = mount({ workflowId: "wf1" });
    show("run-1");
    await settle();
    const region = container.querySelector("p.sr-only[role=\"status\"]")!;
    expect(document.activeElement).not.toBe(container.querySelector("h2"));
    await act(async () => { button(container, "Run again from here").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(container.querySelector("p.sr-only[role=\"status\"]")).toBe(region);
    expect(region.textContent).toBe("Started a new run from Ledger");
    expect(document.activeElement).toBe(container.querySelector("h2"));
  });
});
