// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workflow, WorkflowRun, WorkflowRunUpdate, WorkflowStep } from "../../../shared/workflows";
import { ApiError } from "@/state/api";
import type { Bot } from "@/state/store";
import { applyWorkflowFrame, resetWorkflowsForTest } from "@/state/workflows";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  againStarted: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
  advanced: false,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));

const { WorkflowRunView } = await import("./WorkflowRunView");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scout = { id: "bot-a", name: "Scout", hidden: false, messages: [] } as unknown as Bot;
const ledger = { id: "bot-b", name: "Ledger", hidden: false, messages: [] } as unknown as Bot;
const botStep = (id: string, botId: string, y: number): WorkflowStep => ({ id, kind: "bot", botId, instruction: "Do it", position: { x: 0, y } });
const steps = [botStep("a", "bot-a", 0), botStep("b", "bot-b", 200)];
const connections = [{ id: "c1", from: "a", to: "b" }];
const morning: Workflow = { id: "wf1", name: "Morning round", createdAt: 1, updatedAt: 10, steps, connections };
const NOW = Date.now();
const LONG = "x".repeat(400);

const makeRun = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  runId: "run-1", workflowId: "wf1", routineId: "r1", workflowName: "Morning round", status: "failed", graph: { steps, connections },
  botIds: ["bot-a", "bot-b"], startStepId: "a", threads: {}, createdAt: NOW, updatedAt: NOW,
  stepRuns: [
    { stepId: "a", status: "done", output: "First result" },
    { stepId: "b", status: "failed", botId: "bot-b", errorCode: "turn_failed", threadId: "t-b", output: LONG, outputClipped: true, error: "raw boom", startedAt: NOW, finishedAt: NOW + 120_000 },
  ],
  ...over,
});
const updateOf = (run: WorkflowRun): WorkflowRunUpdate => { const { graph: _graph, ...update } = run; return update; };

let root: Root | null = null;
let current: WorkflowRun;
let others: WorkflowRunUpdate[];
function mount(runId = "run-1", focusHeading = false) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(WorkflowRunView, { workflowId: "wf1", runId, focusHeading, onAgainStarted: fixture.againStarted })));
  return container;
}
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const click = (element: Element) => act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const button = (container: ParentNode, text: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
const statusOf = (container: ParentNode, id: string) => container.querySelector(`[data-workflow-step="${id}"]`)?.getAttribute("data-step-status");

beforeEach(() => {
  vi.useFakeTimers();
  fixture.advanced = false;
  current = makeRun();
  others = [];
  fixture.dispatch.mockReset();
  fixture.againStarted.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
    const method = (init as { method?: string } | undefined)?.method;
    if (path === "/api/workflows") return { workflows: [morning] };
    if (String(path).startsWith("/api/workflows/wf1/runs")) return { runs: [updateOf(current), ...others] };
    if (path === "/api/workflow-runs/run-1") return { run: current };
    if (path === "/api/workflow-runs/run-9") throw new ApiError("no such run", 404);
    if (method === "POST" && String(path).endsWith("/run-again")) return { run: { id: "run-2" } };
    return {};
  });
  fixture.state = { bots: [scout, ledger], routines: [{ id: "r1", name: "Round", prompt: "", workflowId: "wf1" }], routineRuns: [] };
  resetWorkflowsForTest();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the run view", () => {
  it("shows the status of each step on the canvas and updates it from run frames", async () => {
    current = makeRun({ status: "active", currentStepId: "a", stepRuns: [{ stepId: "a", status: "running" }] });
    const container = mount();
    await settle();
    expect(statusOf(container, "a")).toBe("running");
    expect(statusOf(container, "b")).toBe("not_started");
    expect(container.querySelector("[data-workflow-run-status]")?.textContent).toBe("Working on Scout…");
    act(() => applyWorkflowFrame({
      kind: "workflow.run",
      run: updateOf(makeRun({ status: "active", currentStepId: "b", updatedAt: NOW + 1, stepRuns: [{ stepId: "a", status: "done" }, { stepId: "b", status: "running" }] })),
    } as never));
    expect(statusOf(container, "a")).toBe("done");
    expect(statusOf(container, "b")).toBe("running");
    expect(container.querySelector("[data-workflow-run-status]")?.textContent).toBe("Working on Ledger…");
  });

  it("selects the failed step first and shows its error text and result", async () => {
    const container = mount();
    await settle();
    expect(container.querySelector('[data-workflow-step="b"]')?.getAttribute("aria-current")).toBe("true");
    const panel = container.querySelector("[data-workflow-result]")!;
    expect(panel.getAttribute("data-workflow-result")).toBe("b");
    expect(panel.textContent).toContain("Ledger couldn't finish this step.");
    expect(panel.querySelector(".text-danger")).not.toBeNull();
    expect(panel.textContent).toContain("x".repeat(300));
    expect(panel.textContent).not.toContain("x".repeat(301));
    expect(container.textContent).toContain("Failed at Ledger");
  });

  it("offers Run again from here on a failed step and opens the new run", async () => {
    const container = mount();
    await settle();
    await act(async () => { button(container, "Run again from here")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/workflow-runs/run-1/steps/b/run-again", { method: "POST" });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "workflows", workflowId: "wf1", workflowRunId: "run-2" });
    expect(fixture.againStarted).toHaveBeenCalledWith("run-2", "Started a new run from Ledger");
  });

  it.each([
    [403, "forbidden", "You can't change this workflow. Ask a person who can see all its bots."],
    [404, "no such run", "This run is gone."],
    [404, "no such routine", "This run can't start again. Its routine or workflow was removed."],
    [404, "no such workflow", "This run can't start again. Its routine or workflow was removed."],
    [409, "busy", "This step can't run again now. Reload and try again."],
    [500, "boom", "Couldn't start the run. Try again."],
    [503, "asleep", "Couldn't start the run. Try again."],
  ])("says the right thing when Run again answers %i %s", async (status, error, text) => {
    const original = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
      if (String(path).endsWith("/run-again")) throw new ApiError(error, status, { error });
      return original(path, init);
    });
    const container = mount();
    await settle();
    await act(async () => { button(container, "Run again from here")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(text);
    expect(fixture.againStarted).not.toHaveBeenCalled();
  });

  it("says the same for a network failure", async () => {
    const original = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
      if (String(path).endsWith("/run-again")) throw new Error("offline");
      return original(path, init);
    });
    const container = mount();
    await settle();
    await act(async () => { button(container, "Run again from here")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't start the run. Try again.");
  });

  it("moves focus to the heading when asked to, once the run shows", async () => {
    const container = mount("run-1", true);
    await settle();
    expect(document.activeElement).toBe(container.querySelector("h2"));
  });

  it("turns Run again from here off while a run of the routine works, and says why", async () => {
    fixture.state = { ...fixture.state, routineRuns: [{ id: "run-5", routineId: "r1", status: "running" }] };
    const container = mount();
    await settle();
    const again = button(container, "Run again from here")!;
    expect(again.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector(`#${again.getAttribute("aria-describedby")}`)?.textContent).toBe("A run is already working.");
    click(again);
    expect(fixture.api).not.toHaveBeenCalledWith(expect.stringContaining("run-again"), expect.anything());
  });

  it("says the routine now runs another workflow and offers no Run again", async () => {
    fixture.state = { ...fixture.state, routines: [{ id: "r1", name: "Round", prompt: "", workflowId: "wf-other" }] };
    const container = mount();
    await settle();
    expect(container.textContent).toContain("This routine now runs another workflow.");
    expect(button(container, "Run again from here")).toBeUndefined();
  });

  it("says the routine no longer runs a workflow when it went back to instructions", async () => {
    fixture.state = { ...fixture.state, routines: [{ id: "r1", name: "Round", prompt: "Do it" }] };
    const container = mount();
    await settle();
    expect(container.textContent).toContain("This routine no longer runs a workflow.");
    expect(container.textContent).not.toContain("another workflow");
    expect(button(container, "Run again from here")).toBeUndefined();
  });

  it("hides the full-result button once a reload is still clipped, and points to the chat", async () => {
    fixture.advanced = true;
    const container = mount();
    await settle();
    await act(async () => { button(container, "Show the full result")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(button(container, "Show the full result")).toBeUndefined();
    expect(container.textContent).toContain("The full result is in the chat.");
    expect(button(container, "Open the chat")).toBeDefined();
  });

  it("shows the step time and the full result only in Advanced", async () => {
    const simple = mount();
    await settle();
    expect(simple.textContent).not.toContain("Took");
    expect(simple.textContent).not.toContain("raw boom");
    expect(button(simple, "Show the full result")).toBeUndefined();
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    fixture.advanced = true;
    const advanced = mount();
    await settle();
    expect(advanced.textContent).toContain("Took 2 min");
    expect(advanced.textContent).toContain(LONG);
    expect(advanced.textContent).toContain("Details");
    expect(advanced.textContent).toContain("raw boom");
    await act(async () => { button(advanced, "Show the full result")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/workflow-runs/run-1")).toHaveLength(2);
  });

  it("lists the runs of the same routine and opens one", async () => {
    others = [updateOf(makeRun({ runId: "run-0", status: "completed", createdAt: NOW - 86_400_000 * 3, updatedAt: NOW - 86_400_000 * 3 }))];
    const container = mount();
    await settle();
    const rows = [...container.querySelectorAll("aside li button")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(rows[1]!.textContent).toContain("Done");
    click(rows[1]!);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "workflows", workflowId: "wf1", workflowRunId: "run-0" });
  });

  it("offers the chat of a run that has no steps to show", async () => {
    fixture.state = { ...fixture.state, routineRuns: [{ id: "run-9", routineId: "r1", status: "failed", threadId: "t-9" }], routines: [{ id: "r1", name: "Round", prompt: "", workflowId: "wf1", botId: "bot-a" }], groups: [] };
    const container = mount("run-9");
    await settle();
    click(button(container, "Open the chat")!);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "revealThread", threadId: "t-9" });
  });

  it("offers no chat for a missing run whose routine run has no thread", async () => {
    const container = mount("run-9");
    await settle();
    expect(button(container, "Open the chat")).toBeUndefined();
  });

  it("says the run is gone when it can't be found", async () => {
    const container = mount("run-9");
    await settle();
    expect(container.textContent).toContain("This run is gone.");
    click(button(container, "All workflows")!);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "workflows", workflowId: undefined });
  });
});
