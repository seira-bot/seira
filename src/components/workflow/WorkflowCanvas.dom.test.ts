// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workflow, WorkflowGraph, WorkflowStep } from "../../../shared/workflows";
import { draftReducer, fitSteps } from "@/lib/workflow-canvas";
import type { StepView } from "@/lib/workflow-run";
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

const { WorkflowCanvas } = await import("./WorkflowCanvas");
const { WorkflowEditor } = await import("./WorkflowEditor");
const { WorkflowPalette } = await import("./WorkflowPalette");
const { WorkflowStepPanel } = await import("./WorkflowStepPanel");

const scout = { id: "bot-a", name: "Scout", threadId: "t-a", hidden: false, messages: [] } as unknown as Bot;
const ledger = { id: "bot-b", name: "Ledger", threadId: "t-b", hidden: false, messages: [] } as unknown as Bot;
const botName = (id: string) => [scout, ledger].find((bot) => bot.id === id)?.name;

const botStep = (id: string, botId: string, x: number, y: number): WorkflowStep => ({ id, kind: "bot", botId, instruction: "Do it", position: { x, y } });
const checkStep = (id: string, x: number, y: number): WorkflowStep => ({ id, kind: "check", question: "Is it fine?", position: { x, y } });
const graph: WorkflowGraph = {
  steps: [botStep("a", "bot-a", 0, 0), botStep("b", "bot-b", 0, 200)],
  connections: [{ id: "c1", from: "a", to: "b" }],
};

let root: Root | null = null;
function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
  return container;
}
const step = (container: ParentNode, id: string) => container.querySelector<HTMLButtonElement>(`[data-workflow-step="${id}"]`)!;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fire = (target: Element | Document, event: Event) => { act(() => { target.dispatchEvent(event); }); };
const pointer = (target: Element, type: string, x = 0, y = 0) =>
  fire(target, new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
const key = (target: Element | Document, name: string, init: KeyboardEventInit = {}) =>
  fire(target, new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
const world = (container: ParentNode) => container.querySelector<HTMLElement>("[data-workflow-world]")!;
const region = (container: ParentNode) => container.querySelector<HTMLElement>("[data-workflow-canvas]")!;

function canvasProps(overrides: Record<string, unknown> = {}) {
  const edit = { dispatch: vi.fn(), problems: {}, onRemove: vi.fn(), onAnnounce: vi.fn() };
  return { edit, props: { graph, botName, selectedId: null, onSelect: vi.fn(), label: "Workflow steps", edit, ...overrides } };
}

beforeEach(() => {
  vi.useRealTimers();
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.state = { bots: [scout, ledger], routines: [] };
  resetWorkflowsForTest();
  delete document.documentElement.dataset.reducedMotion;
});
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the workflow canvas", () => {
  it("lists each step as a button in reading order, with its kind and title", () => {
    const { props } = canvasProps({ graph: {
      steps: [botStep("b", "bot-b", 0, 200), { id: "n", kind: "note", text: "Remember this", position: { x: 400, y: 0 } }, botStep("a", "bot-a", 0, 0)],
      connections: [{ id: "c1", from: "a", to: "b" }],
    } });
    const container = mount(createElement(WorkflowCanvas, props as never));
    const labels = [...container.querySelectorAll("[data-workflow-step]")].map((node) => node.getAttribute("aria-label"));
    expect(labels).toEqual(["Bot step: Scout", "Bot step: Ledger", "Note: Remember this"]);
    expect(region(container).getAttribute("aria-label")).toBe("Workflow steps");
    expect(container.querySelector("#" + CSS.escape(region(container).getAttribute("aria-describedby")!))!.textContent).toContain("Arrow keys move the view");
  });

  it("shows the first line of a bot step's instruction under its name, and nothing for an empty one", () => {
    const { props } = canvasProps({ graph: {
      steps: [{ ...botStep("a", "bot-a", 0, 0), instruction: "\n  Pull today's orders  \nthen total them" }, { ...botStep("b", "bot-b", 0, 200), instruction: "  " }, checkStep("c", 400, 0)],
      connections: [],
    } });
    const container = mount(createElement(WorkflowCanvas, props as never));
    const line = (id: string) => step(container, id).querySelector<HTMLElement>("[data-workflow-step-instruction]");
    expect(line("a")?.textContent).toBe("Pull today's orders");
    expect(line("a")?.className).toContain("line-clamp-1");
    expect(line("b")).toBeNull();
    expect(line("c")).toBeNull();
    expect(step(container, "a").getAttribute("aria-label")).toBe("Bot step: Scout");
  });

  it("moves the focused step 8 px with an arrow key and 40 px with Shift, and announces it", () => {
    vi.useFakeTimers();
    const { props, edit } = canvasProps();
    const container = mount(createElement(WorkflowCanvas, props as never));
    key(step(container, "a"), "ArrowRight");
    expect(edit.dispatch).toHaveBeenLastCalledWith({ type: "move", stepId: "a", position: { x: 8, y: 0 } });
    key(step(container, "a"), "ArrowDown", { shiftKey: true });
    expect(edit.dispatch).toHaveBeenLastCalledWith({ type: "move", stepId: "a", position: { x: 0, y: 40 } });
    expect(edit.onAnnounce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(edit.onAnnounce).toHaveBeenCalledTimes(1);
    expect(edit.onAnnounce).toHaveBeenCalledWith("Moved Scout");
  });

  it("moves a step with a pointer drag past 5 px and snaps it on release, and selects it on a click without movement", () => {
    const onSelect = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState<WorkflowGraph>(graph);
      const edit = { dispatch: (action: Parameters<typeof draftReducer>[1]) => setCurrent((previous) => ({ ...previous, ...draftReducer({ name: "x", ...previous }, action) })), problems: {}, onRemove: vi.fn(), onAnnounce: vi.fn() };
      return createElement(WorkflowCanvas, { graph: current, botName, selectedId: null, onSelect, label: "Workflow steps", edit });
    }
    const container = mount(createElement(Harness));
    const card = step(container, "a");
    pointer(card, "pointerdown", 100, 100);
    pointer(card, "pointermove", 102, 100);
    expect(card.style.left).toBe("0px");
    pointer(card, "pointermove", 143, 121);
    expect(card.style.left).toBe("43px");
    pointer(card, "pointerup", 143, 121);
    expect(card.style.left).toBe("40px");
    expect(card.style.top).toBe("24px");
    expect(onSelect).not.toHaveBeenCalled();
    const other = step(container, "b");
    pointer(other, "pointerdown", 100, 300);
    pointer(other, "pointerup", 100, 300);
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(other.style.top).toBe("200px");
  });

  it("connects two steps by a drag from the out port to the other step", () => {
    const { props, edit } = canvasProps({ graph: { steps: graph.steps, connections: [] } });
    const container = mount(createElement(WorkflowCanvas, props as never));
    const stub = vi.fn(() => step(container, "b"));
    Object.defineProperty(document, "elementFromPoint", { value: stub, configurable: true });
    const port = step(container, "a").querySelector("[data-workflow-port=out]")!;
    pointer(port, "pointerdown", 124, 112);
    pointer(port, "pointermove", 130, 250);
    expect(container.querySelector("path[stroke-dasharray]")).not.toBeNull();
    pointer(port, "pointerup", 130, 250);
    expect(edit.dispatch).toHaveBeenCalledWith({ type: "connect", connection: expect.objectContaining({ from: "a", to: "b" }) });
    expect(edit.onAnnounce).toHaveBeenCalledWith("Connected Scout to Ledger");
    expect(container.querySelector("path[stroke-dasharray]")).toBeNull();
  });

  it("refuses a drag onto the same step and says why", () => {
    const { props, edit } = canvasProps({ graph: { steps: graph.steps, connections: [] } });
    const container = mount(createElement(WorkflowCanvas, props as never));
    Object.defineProperty(document, "elementFromPoint", { value: () => step(container, "a"), configurable: true });
    const port = step(container, "a").querySelector("[data-workflow-port=out]")!;
    pointer(port, "pointerdown", 124, 112);
    pointer(port, "pointermove", 130, 150);
    pointer(port, "pointerup", 130, 150);
    expect(edit.dispatch).not.toHaveBeenCalled();
    expect(edit.onAnnounce).toHaveBeenCalledWith("A step can't connect to itself.");
  });

  it("connects a check's Yes and No ports to different steps", () => {
    const flow: WorkflowGraph = { steps: [checkStep("k", 0, 0), botStep("y", "bot-a", -200, 240), botStep("n", "bot-b", 200, 240)], connections: [] };
    const { props, edit } = canvasProps({ graph: flow });
    const container = mount(createElement(WorkflowCanvas, props as never));
    const check = step(container, "k");
    expect(check.querySelector("[data-workflow-port=out]")).toBeNull();
    for (const [side, target] of [["yes", "y"], ["no", "n"]] as const) {
      Object.defineProperty(document, "elementFromPoint", { value: () => step(container, target), configurable: true });
      const port = check.querySelector(`[data-workflow-port=${side}]`)!;
      pointer(port, "pointerdown", 100, 112);
      pointer(port, "pointermove", 100, 260);
      pointer(port, "pointerup", 100, 260);
    }
    expect(edit.dispatch).toHaveBeenNthCalledWith(1, { type: "connect", connection: expect.objectContaining({ from: "k", to: "y", branch: "yes" }) });
    expect(edit.dispatch).toHaveBeenNthCalledWith(2, { type: "connect", connection: expect.objectContaining({ from: "k", to: "n", branch: "no" }) });
  });

  it("names a check's branch once: on its port while editing, on its line when read-only", () => {
    const flow: WorkflowGraph = { steps: [checkStep("k", 0, 0), botStep("y", "bot-a", 0, 240)], connections: [{ id: "c-yes", from: "k", to: "y", branch: "yes" }] };
    const labels = (container: ParentNode) => [...container.querySelectorAll("[data-workflow-port=yes], [data-workflow-connection=c-yes]")].filter((node) => node.textContent === "Yes").length;
    const editing = mount(createElement(WorkflowCanvas, canvasProps({ graph: flow }).props as never));
    expect(labels(editing)).toBe(1);
    expect(editing.querySelector("[data-workflow-connection=c-yes]")!.textContent).toBe("");
    const reading = mount(createElement(WorkflowCanvas, canvasProps({ graph: flow, edit: undefined }).props as never));
    expect(reading.querySelector("[data-workflow-port=yes]")).toBeNull();
    expect(reading.querySelector("[data-workflow-connection=c-yes]")!.textContent).toBe("Yes");
  });

  it("pans with arrow keys on the empty canvas, zooms with plus and minus, and fits with 0", () => {
    const { props } = canvasProps();
    const container = mount(createElement(WorkflowCanvas, props as never));
    const canvas = region(container);
    expect(world(container).style.transform).toBe("translate(40px, 40px) scale(1)");
    key(canvas, "ArrowLeft");
    expect(world(container).style.transform).toBe("translate(100px, 40px) scale(1)");
    key(canvas, "ArrowDown");
    expect(world(container).style.transform).toBe("translate(100px, -20px) scale(1)");
    key(canvas, "+");
    expect(world(container).style.transform).toContain("scale(1.2)");
    key(canvas, "-");
    expect(Number(/scale\(([\d.]+)\)/.exec(world(container).style.transform)![1])).toBeCloseTo(1, 5);
    key(canvas, "0");
    expect(world(container).style.transform).toBe("translate(40px, 40px) scale(1)");
    key(step(container, "a"), "ArrowLeft");
    expect(world(container).style.transform).toBe("translate(40px, 40px) scale(1)");
  });

  it("fits all steps into the size of the canvas with 0 and with the fit button", () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) } as DOMRect; };
    try {
      const { props } = canvasProps();
      const container = mount(createElement(WorkflowCanvas, props as never));
      const expected = fitSteps(graph.steps, 400, 300);
      expect(expected.scale).toBeLessThan(1);
      const asText = (view: { x: number; y: number; scale: number }) => `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      expect(world(container).style.transform).toBe(asText(expected));
      key(region(container), "+");
      expect(world(container).style.transform).not.toBe(asText(expected));
      key(region(container), "0");
      expect(world(container).style.transform).toBe(asText(expected));
      key(region(container), "-");
      fire(container.querySelector("[aria-label='Show all steps']") ?? container.querySelector("button[title]")!, new MouseEvent("click", { bubbles: true }));
      expect(world(container).style.transform).toBe(asText(expected));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("visits steps outside the flow from top to bottom, then left to right", () => {
    const note = (id: string, x: number, y: number): WorkflowStep => ({ id, kind: "note", text: id, position: { x, y } });
    const { props } = canvasProps({ graph: { steps: [note("late", 200, 100), note("left", 0, 100), note("top", 100, 0), botStep("a", "bot-a", 0, 300)], connections: [] } });
    const container = mount(createElement(WorkflowCanvas, props as never));
    expect([...container.querySelectorAll("[data-workflow-step]")].map((node) => node.getAttribute("data-workflow-step"))).toEqual(["a", "top", "left", "late"]);
  });

  it("removes a selected connection with its remove button", () => {
    const { props, edit } = canvasProps();
    const container = mount(createElement(WorkflowCanvas, props as never));
    expect(container.querySelector("[data-workflow-edge-button]")).toBeNull();
    fire(container.querySelector("[data-workflow-connection-hit=c1]")!, new MouseEvent("click", { bubbles: true }));
    const remove = container.querySelector<HTMLButtonElement>("[data-workflow-edge-button]")!;
    expect(remove.getAttribute("aria-label")).toBe("Remove the connection from Scout to Ledger");
    fire(remove, new MouseEvent("click", { bubbles: true }));
    expect(edit.dispatch).toHaveBeenCalledWith({ type: "disconnect", connectionId: "c1" });
    expect(edit.onAnnounce).toHaveBeenCalledWith("Removed the connection from Scout to Ledger");
    expect(container.querySelector("[data-workflow-edge-button]")).toBeNull();
  });

  it("renders no transition or animation class while reduced motion is on", () => {
    document.documentElement.dataset.reducedMotion = "true";
    const statuses: Record<string, StepView> = { a: { state: "running" }, b: { state: "not_started" } };
    const { props } = canvasProps({ statuses, edit: { dispatch: vi.fn(), problems: { b: "Choose a bot." }, onRemove: vi.fn(), onAnnounce: vi.fn() } });
    const container = mount(createElement(WorkflowCanvas, props as never));
    expect(region(container).getAttribute("data-reduced-motion")).toBe("true");
    const offenders = [...container.querySelectorAll("*")].flatMap((node) => (node.getAttribute("class") ?? "").split(/\s+/)).filter((name) => /^(transition|animate)-?/.test(name) || /:(transition|animate)-/.test(name));
    expect(offenders).toEqual([]);
    flushSync(() => root!.unmount());
    root = null;
    delete document.documentElement.dataset.reducedMotion;
    const moving = mount(createElement(WorkflowCanvas, { ...props, edit: undefined } as never));
    expect(region(moving).getAttribute("data-reduced-motion")).toBe("false");
    expect(moving.innerHTML).toContain("animate-spin");
    expect(moving.innerHTML).toContain("motion-reduce:animate-none");
  });

  it("renders no transition or animation class in the step panel and the palette while reduced motion is on", () => {
    document.documentElement.dataset.reducedMotion = "true";
    const wait: WorkflowStep = { id: "w", kind: "wait", minutes: 5, position: { x: 0, y: 0 } };
    const panel = mount(createElement("div", null,
      createElement(WorkflowPalette, { onAdd: vi.fn() }),
      createElement(WorkflowStepPanel, { draft: { name: "Flow", steps: [wait, botStep("a", "bot-a", 0, 200)], connections: [] }, step: wait, bots: [scout, ledger], botName, dispatch: vi.fn(), onRemove: vi.fn(), onAnnounce: vi.fn() })));
    expect(panel.querySelector("[data-workflow-palette]")).not.toBeNull();
    expect(panel.querySelector("aside")).not.toBeNull();
    const offenders = [...panel.querySelectorAll("*")].flatMap((node) => (node.getAttribute("class") ?? "").split(/\s+/)).filter((name) => /^(transition|animate)-?/.test(name) || /:(transition|animate)-/.test(name));
    expect(offenders).toEqual([]);
  });

  it("shows each step's status and moves nothing in read-only mode", () => {
    const statuses: Record<string, StepView> = { a: { state: "done" }, b: { state: "failed" } };
    const onSelect = vi.fn();
    const container = mount(createElement(WorkflowCanvas, { graph, botName, selectedId: null, onSelect, label: "Run steps", statuses } as never));
    expect(step(container, "a").getAttribute("data-step-status")).toBe("done");
    expect(step(container, "a").textContent).toContain("Done");
    expect(step(container, "b").textContent).toContain("Failed");
    expect(container.querySelector("[data-workflow-port]")).toBeNull();
    key(step(container, "a"), "ArrowRight");
    key(step(container, "a"), "Delete");
    expect(step(container, "a").style.left).toBe("0px");
    expect(container.querySelector("[data-workflow-connection-hit]")).toBeNull();
    fire(step(container, "b"), new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});

const flow: Workflow = { id: "wf1", name: "Morning", steps: graph.steps, connections: graph.connections, createdAt: 1, updatedAt: 10 };
function editorApi() {
  fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
    if (path === "/api/workflows" && !(init as { method?: string } | undefined)?.method) return { workflows: [flow] };
    if ((init as { method?: string } | undefined)?.method === "PATCH") return { workflow: { ...flow, updatedAt: 11 } };
    return {};
  });
}
const mountEditor = async (workflow: Workflow = flow) => {
  editorApi();
  const container = mount(createElement(WorkflowEditor, { workflow, usedBy: [], onBack: vi.fn(), onGone: vi.fn(), onDelete: vi.fn(async () => {}) }));
  await vi.waitFor(() => expect(fixture.api).toHaveBeenCalled());
  return container;
};
const stepCount = (container: ParentNode) => container.querySelectorAll("[data-workflow-step]").length;
const palette = (container: ParentNode, label: string) => container.querySelector<HTMLButtonElement>(`button[data-workflow-palette][aria-label="${label}"]`)!;

describe("the workflow editor on the canvas", () => {
  it("adds a step from the palette by click and by drop at the drop point", async () => {
    const container = await mountEditor({ ...flow, steps: [], connections: [] });
    expect(container.textContent).toContain("Add a bot step to start this workflow.");
    fire(palette(container, "Bot step"), new MouseEvent("click", { bubbles: true }));
    expect(stepCount(container)).toBe(1);
    const first = container.querySelector<HTMLElement>("[data-workflow-step]")!;
    expect(first.getAttribute("aria-label")).toBe("Bot step: Scout");
    fire(palette(container, "AI check"), new MouseEvent("click", { bubbles: true }));
    expect(stepCount(container)).toBe(2);
    expect(container.querySelectorAll("[data-workflow-connection]")).toHaveLength(1);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      clientX: { value: 400 }, clientY: { value: 300 },
      dataTransfer: { value: { types: ["application/x-seira-step"], getData: () => "wait" } },
    });
    fire(region(container), drop);
    expect(stepCount(container)).toBe(3);
    const waiting = container.querySelector<HTMLElement>("[data-workflow-step][aria-label^='Wait']")!;
    expect(waiting.style.left).toBe("240px");
    expect(waiting.style.top).toBe("208px");
  });

  it("removes the focused step with Delete at once and shows Undo, and Undo brings back the step and its connections", async () => {
    const container = await mountEditor();
    expect(stepCount(container)).toBe(2);
    key(step(container, "b"), "Delete");
    expect(stepCount(container)).toBe(1);
    expect(container.querySelectorAll("[data-workflow-connection]")).toHaveLength(0);
    const toast = document.body.querySelector("[data-access-toast]")!;
    expect(toast.textContent).toContain("Deleted Ledger");
    fire([...toast.querySelectorAll("button")].find((candidate) => candidate.textContent === "Undo")!, new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(stepCount(container)).toBe(2));
    expect(container.querySelectorAll("[data-workflow-connection]")).toHaveLength(1);
    await vi.waitFor(() => expect(document.activeElement).toBe(step(container, "b")));
  });

  it("undoes the last removal with Ctrl+Z while Undo shows", async () => {
    const container = await mountEditor();
    key(step(container, "a"), "Delete");
    key(step(container, "b"), "Delete");
    expect(stepCount(container)).toBe(0);
    expect(document.body.querySelectorAll("[data-access-toast]")).toHaveLength(1);
    key(document, "z", { ctrlKey: true });
    await vi.waitFor(() => expect(stepCount(container)).toBe(1));
    expect(container.querySelector("[data-workflow-step=b]")).not.toBeNull();
    key(document, "z", { ctrlKey: true });
    expect(stepCount(container)).toBe(1);
  });
});
