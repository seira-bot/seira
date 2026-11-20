// @vitest-environment happy-dom
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowStep } from "../../../shared/workflows";
import type { DraftAction } from "@/lib/workflow-canvas";
import type { Bot } from "@/state/store";
import type { WorkflowDraft } from "@/state/workflows";
import { WorkflowStepPanel } from "./WorkflowStepPanel";

const scout = { id: "bot-a", name: "Scout" } as unknown as Bot;
const ledger = { id: "bot-b", name: "Ledger" } as unknown as Bot;
const bots = [scout, ledger];
const botName = (id: string) => bots.find((bot) => bot.id === id)?.name;

const botStep = (id: string, botId: string, y: number): WorkflowStep => ({ id, kind: "bot", botId, instruction: "Do it", position: { x: 0, y } });

let root: Root | null = null;
function mount(draft: WorkflowDraft, stepId: string | null, extra: { problem?: string } = {}) {
  const dispatch = vi.fn<(action: DraftAction) => void>();
  const onRemove = vi.fn();
  const onAnnounce = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const step = draft.steps.find((candidate) => candidate.id === stepId) ?? null;
  flushSync(() => root!.render(createElement(WorkflowStepPanel, { draft, step, bots, botName, dispatch, onRemove, onAnnounce, ...extra })));
  return { container, dispatch, onRemove, onAnnounce };
}
function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  flushSync(() => { element.dispatchEvent(new Event("input", { bubbles: true })); });
}
function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  flushSync(() => { select.dispatchEvent(new Event("change", { bubbles: true })); });
}
const byLabel = <T extends HTMLElement>(container: ParentNode, label: string) => {
  const found = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  return container.querySelector<T>(`#${CSS.escape(found!.htmlFor)}`)!;
};

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the step panel", () => {
  it("shows Select a step to change it when no step is selected", () => {
    const { container } = mount({ name: "Flow", steps: [botStep("a", "bot-a", 0)], connections: [] }, null);
    expect(container.textContent).toContain("Select a step to change it.");
  });

  it("changes a bot step's bot with Select and its instruction with the text field", () => {
    const { container, dispatch } = mount({ name: "Flow", steps: [botStep("a", "bot-a", 0)], connections: [] }, "a");
    choose(byLabel(container, "Bot"), "bot-b");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "change", stepId: "a", patch: { botId: "bot-b" } });
    type(byLabel(container, "What to do"), "Check the stock");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "change", stepId: "a", patch: { instruction: "Check the stock" } });
  });

  it("connects a step with Then, and stops it with Nothing, stop here", () => {
    const open = { name: "Flow", steps: [botStep("a", "bot-a", 0), botStep("b", "bot-b", 200)], connections: [] };
    const first = mount(open, "a");
    choose(byLabel(first.container, "Then"), "b");
    expect(first.dispatch).toHaveBeenCalledWith({ type: "connect", connection: expect.objectContaining({ from: "a", to: "b" }) });
    expect(first.onAnnounce).toHaveBeenCalledWith("Connected Scout to Ledger");
    flushSync(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    const linked = mount({ ...open, connections: [{ id: "c1", from: "a", to: "b" }] }, "a");
    const select = byLabel<HTMLSelectElement>(linked.container, "Then");
    expect(select.value).toBe("b");
    choose(select, "");
    expect(linked.dispatch).toHaveBeenCalledWith({ type: "disconnect", connectionId: "c1" });
  });

  it("sets If yes and If no on a check, and offers no step that would make a loop", () => {
    const flow: WorkflowDraft = {
      name: "Flow",
      steps: [botStep("a", "bot-a", 0), { id: "k", kind: "check", question: "Fine?", position: { x: 0, y: 200 } }, botStep("b", "bot-b", 400), botStep("c", "bot-a", 600)],
      connections: [{ id: "c1", from: "a", to: "k" }, { id: "c2", from: "b", to: "c" }],
    };
    const { container, dispatch } = mount(flow, "k");
    const yes = byLabel<HTMLSelectElement>(container, "If yes");
    expect([...yes.options].map((option) => option.value)).not.toContain("a");
    expect(yes.options.length).toBeGreaterThan(1);
    choose(yes, "b");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "connect", connection: expect.objectContaining({ from: "k", to: "b", branch: "yes" }) });
    choose(byLabel(container, "If no"), "c");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "connect", connection: expect.objectContaining({ from: "k", to: "c", branch: "no" }) });
  });

  it("shows a change to the wait from outside, keeps the field when typing, and flags an empty amount", () => {
    const wait: WorkflowStep = { id: "w", kind: "wait", minutes: 30, position: { x: 0, y: 0 } };
    const props = (minutes: number) => {
      const step = { ...wait, minutes };
      return { draft: { name: "Flow", steps: [step], connections: [] }, step, bots, botName, dispatch: vi.fn(), onRemove: vi.fn(), onAnnounce: vi.fn() };
    };
    const { container } = mount({ name: "Flow", steps: [wait], connections: [] }, "w");
    const amount = byLabel<HTMLInputElement>(container, "Wait for");
    type(amount, "");
    expect(byLabel(container, "Wait for")).toBe(amount);
    expect(container.querySelector("[data-step-problem]")!.textContent).toBe("Wait: choose 1 minute to 30 days.");
    expect(amount.value).toBe("");
    flushSync(() => root!.render(createElement(WorkflowStepPanel, props(120))));
    expect(byLabel<HTMLInputElement>(container, "Wait for").value).toBe("2");
    expect(byLabel<HTMLSelectElement>(container, "Unit").value).toBe("hours");
    expect(container.querySelector("[data-step-problem]")).toBeNull();
  });

  it("turns a wait of 2 Hours into 120 minutes, and shows the range problem outside 1 minute to 30 days", () => {
    const wait: WorkflowStep = { id: "w", kind: "wait", minutes: 30, position: { x: 0, y: 0 } };
    const dispatch = vi.fn<(action: DraftAction) => void>();
    function Harness() {
      const [current, setCurrent] = useState<WorkflowStep>(wait);
      const apply = (action: DraftAction) => {
        dispatch(action);
        if (action.type === "change") setCurrent((previous) => ({ ...previous, ...action.patch }) as WorkflowStep);
      };
      return createElement(WorkflowStepPanel, { draft: { name: "Flow", steps: [current], connections: [] }, step: current, bots, botName, dispatch: apply, onRemove: vi.fn(), onAnnounce: vi.fn() });
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(Harness)));
    choose(byLabel(container, "Unit"), "hours");
    type(byLabel(container, "Wait for"), "2");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "change", stepId: "w", patch: { minutes: 120 } });
    flushSync(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    const bad = mount({ name: "Flow", steps: [{ ...wait, minutes: 0 }], connections: [] }, "w");
    expect(bad.container.querySelector("[data-step-problem]")!.textContent).toBe("Wait: choose 1 minute to 30 days.");
  });

  it("shows the help line for Post results and the text field for a note", () => {
    const post = mount({ name: "Flow", steps: [{ id: "p", kind: "post", position: { x: 0, y: 0 } }], connections: [] }, "p");
    expect(post.container.textContent).toContain("Posts the result of the step before it");
    flushSync(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    const note = mount({ name: "Flow", steps: [{ id: "n", kind: "note", text: "Hi", position: { x: 0, y: 0 } }], connections: [] }, "n");
    type(byLabel(note.container, "Note"), "Hello");
    expect(note.dispatch).toHaveBeenCalledWith({ type: "change", stepId: "n", patch: { text: "Hello" } });
    expect(note.container.querySelector("select")).toBeNull();
  });

  it("shows the problem of the selected step", () => {
    const { container } = mount({ name: "Flow", steps: [botStep("a", "bot-a", 0)], connections: [] }, "a", { problem: "Scout: tell the bot what to do in this step." });
    expect(container.querySelector("[data-step-problem]")!.textContent).toBe("Scout: tell the bot what to do in this step.");
  });

  it("deletes the step with Delete step", () => {
    const { container, onRemove } = mount({ name: "Flow", steps: [botStep("a", "bot-a", 0)], connections: [] }, "a");
    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Delete step")!;
    flushSync(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onRemove).toHaveBeenCalledWith("a");
  });
});
