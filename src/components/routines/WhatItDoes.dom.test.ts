// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workflow, WorkflowStep } from "../../../shared/workflows";
import type { Bot } from "@/state/store";
import { resetWorkflowsForTest } from "@/state/workflows";
import type { WhatItDoesWorkflow } from "./WorkflowSlot";

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

const { WhatItDoes } = await import("./WhatItDoes");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scout = { id: "bot-a", name: "Scout", hidden: false, messages: [] } as unknown as Bot;
const ledger = { id: "bot-b", name: "Ledger", hidden: false, messages: [] } as unknown as Bot;
const botStep = (id: string, botId: string, y: number): WorkflowStep => ({ id, kind: "bot", botId, instruction: "Do it", position: { x: 0, y } });
const morning: Workflow = {
  id: "wf1", name: "Morning round", createdAt: 1, updatedAt: 10,
  steps: [botStep("a", "bot-a", 0), botStep("b", "bot-b", 200)],
  connections: [{ id: "c1", from: "a", to: "b" }],
};
const evening: Workflow = { id: "wf2", name: "Evening round", createdAt: 1, updatedAt: 10, steps: [botStep("x", "bot-b", 0)], connections: [] };
const empty: Workflow = { id: "wf3", name: "Blank", createdAt: 1, updatedAt: 10, steps: [], connections: [] };

let root: Root | null = null;
let workflows: Workflow[];
const slot = (over: Partial<WhatItDoesWorkflow> = {}): WhatItDoesWorkflow => ({ choice: { mode: "workflow", id: null }, onChange: vi.fn(), block: null, clears: false, ...over });
function mount(workflow?: WhatItDoesWorkflow, extra: { value?: string; onChange?: (value: string) => void } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(WhatItDoes, { value: extra.value ?? "Summarize the inbox", onChange: extra.onChange ?? vi.fn(), placeholder: "p", label: "What it does", workflow })));
  return container;
}
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const click = (element: Element) => act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const byLabel = (container: ParentNode, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
  workflows = [morning, evening, empty];
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: unknown) => (path === "/api/workflows" ? { workflows } : {}));
  fixture.state = { bots: [scout, ledger], routines: [] };
  resetWorkflowsForTest();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("What it does", () => {
  it("shows only the instructions field without the workflow prop", async () => {
    const container = mount();
    await settle();
    expect(container.querySelector("textarea")?.value).toBe("Summarize the inbox");
    expect(container.querySelector("[data-what-it-does]")).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("offers the choice only after the list has loaded, or when the routine already has a workflow", async () => {
    let release: (value: unknown) => void = () => {};
    fixture.api.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const waiting = mount(slot({ choice: { mode: "instructions" } }));
    await settle();
    expect(waiting.querySelector("[data-what-it-does]")).toBeNull();
    expect(waiting.querySelector("textarea")).not.toBeNull();
    await act(async () => { release({ workflows }); });
    await settle();
    expect(waiting.querySelector("[data-what-it-does]")).not.toBeNull();
    act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    resetWorkflowsForTest();
    fixture.api.mockImplementation(() => new Promise(() => {}));
    const chosen = mount(slot({ choice: { mode: "workflow", id: "wf1" } }));
    await settle();
    expect(chosen.querySelector("[data-what-it-does]")).not.toBeNull();
  });

  it("hides the choice when the list can't be loaded", async () => {
    fixture.api.mockImplementation(async () => { throw new TypeError("offline"); });
    const container = mount(slot({ choice: { mode: "instructions" } }));
    await settle();
    expect(container.querySelector("[data-what-it-does]")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("switches between Instructions and Workflow, and keeps the typed instructions", async () => {
    const onChange = vi.fn();
    const container = mount(slot({ choice: { mode: "instructions" }, onChange }));
    await settle();
    expect(container.querySelector("textarea")?.value).toBe("Summarize the inbox");
    expect(container.querySelector('[data-what-it-does="instructions"]')?.getAttribute("aria-pressed")).toBe("true");
    click(container.querySelector('[data-what-it-does="workflow"]')!);
    expect(onChange).toHaveBeenCalledWith({ mode: "workflow", id: null });
    act(() => root!.render(createElement(WhatItDoes, { value: "Summarize the inbox", onChange: vi.fn(), placeholder: "p", label: "What it does", workflow: slot({ choice: { mode: "workflow", id: null }, onChange }) })));
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[data-workflow-slot]")).not.toBeNull();
    click(container.querySelector('[data-what-it-does="instructions"]')!);
    expect(onChange).toHaveBeenLastCalledWith({ mode: "instructions" });
    act(() => root!.render(createElement(WhatItDoes, { value: "Summarize the inbox", onChange: vi.fn(), placeholder: "p", label: "What it does", workflow: slot({ choice: { mode: "instructions" }, onChange }) })));
    expect(container.querySelector("textarea")?.value).toBe("Summarize the inbox");
  });

  it("picks a workflow with Use and reports its first bot", async () => {
    const onChange = vi.fn();
    const container = mount(slot({ onChange }));
    await settle();
    click(byLabel(container, "Use Morning round"));
    expect(onChange).toHaveBeenCalledWith({ mode: "workflow", id: "wf1" }, "bot-a");
  });

  it("picks a workflow by a drop on the slot", async () => {
    const onChange = vi.fn();
    const container = mount(slot({ onChange }));
    await settle();
    const target = container.querySelector("[data-workflow-slot]")!;
    const drop = (id: string) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer: { types: ["application/x-seira-workflow"], getData: () => id } });
      act(() => { target.dispatchEvent(event); });
      return event;
    };
    expect(drop("wf2").defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith({ mode: "workflow", id: "wf2" }, "bot-b");
    onChange.mockClear();
    drop("wf3");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the chosen workflow with its thumbnail, steps and bots, and Remove empties the slot", async () => {
    const onChange = vi.fn();
    const container = mount(slot({ choice: { mode: "workflow", id: "wf1" }, onChange }));
    await settle();
    const chosen = container.querySelector("[data-workflow-slot]")!;
    expect(chosen.querySelector("svg[data-workflow-thumb]")).not.toBeNull();
    expect(chosen.textContent).toContain("Morning round");
    expect(chosen.textContent).toContain("2 steps · Scout and Ledger");
    expect(container.querySelector('[data-workflow-card="wf1"]')?.textContent).toContain("In use");
    click(byLabel(container, "Stop using Morning round"));
    expect(onChange).toHaveBeenCalledWith({ mode: "workflow", id: null });
  });

  it("turns Use off with the reason for a workflow that starts with another bot or can't run", async () => {
    const onChange = vi.fn();
    const container = mount(slot({ onChange, lockedBotId: "bot-a" }));
    await settle();
    const evening = byLabel(container, "Use Evening round");
    expect(evening.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector(`#${CSS.escape(evening.getAttribute("aria-describedby")!)}`)?.textContent).toContain("It starts with Ledger.");
    expect(container.querySelector('[data-workflow-card="wf2"]')?.textContent).toContain("It starts with Ledger. This routine belongs to another bot.");
    expect(byLabel(container, "Use Blank").getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector('[data-workflow-card="wf3"]')?.textContent).toContain("Add a bot step to start this workflow.");
    click(evening);
    expect(onChange).not.toHaveBeenCalled();
    expect(byLabel(container, "Use Morning round").hasAttribute("aria-disabled")).toBe(false);
  });

  it("says why a team goal, a cloud desktop or a limit reset can't run a workflow", async () => {
    const container = mount(slot({ block: "room" }));
    await settle();
    expect(container.textContent).toContain("A team goal can't run a workflow.");
    for (const [block, text] of [["cloud", "A workflow can't run on a cloud desktop."], ["limit", "A workflow can't start when a usage limit resets."]] as const) {
      act(() => root!.render(createElement(WhatItDoes, { value: "", onChange: vi.fn(), placeholder: "p", label: "What it does", workflow: slot({ block }) })));
      expect(container.textContent).toContain(text);
    }
  });

  it("says the workflow is gone when the chosen id is not in the list", async () => {
    const container = mount(slot({ choice: { mode: "workflow", id: "wf-missing" } }));
    await settle();
    expect(container.textContent).toContain("That workflow is gone.");
  });

  it("warns that saving turns off the model choice, checks and delivery settings", async () => {
    const container = mount(slot({ clears: true }));
    await settle();
    expect(container.textContent).toContain("Saving turns them off.");
    act(() => root!.render(createElement(WhatItDoes, { value: "", onChange: vi.fn(), placeholder: "p", label: "What it does", workflow: slot({ clears: false }) })));
    expect(container.textContent).not.toContain("Saving turns them off.");
  });

  it("accepts only a workflow on a drag over the slot, and ignores a foreign drag or drop", async () => {
    const onChange = vi.fn();
    const container = mount(slot({ onChange }));
    await settle();
    const target = container.querySelector("[data-workflow-slot]")!;
    const fire = (kind: "dragover" | "drop", types: string[]) => {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer: { types, getData: () => "wf1" } });
      act(() => { target.dispatchEvent(event); });
      return event;
    };
    expect(fire("dragover", ["application/x-seira-workflow"]).defaultPrevented).toBe(true);
    expect(fire("dragover", ["text/plain"]).defaultPrevented).toBe(false);
    expect(fire("drop", ["text/plain"]).defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows neither gone, none nor the drop text for a chosen workflow while the list is loading", async () => {
    fixture.api.mockImplementation(() => new Promise(() => {}));
    const container = mount(slot({ choice: { mode: "workflow", id: "wf1" } }));
    await settle();
    expect(container.textContent).not.toContain("gone");
    expect(container.textContent).not.toContain("You have no workflows");
    expect(container.textContent).not.toContain("Drag a workflow here");
    expect(container.querySelector(".animate-spin")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("says the list couldn't load, not gone or none, and reloads it with Try again", async () => {
    let fail = true;
    fixture.api.mockImplementation(async (path: unknown) => {
      if (path === "/api/workflows" && fail) throw new TypeError("offline");
      return path === "/api/workflows" ? { workflows } : {};
    });
    const container = mount(slot({ choice: { mode: "workflow", id: "wf1" } }));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your workflows.");
    expect(container.textContent).not.toContain("That workflow is gone.");
    expect(container.textContent).not.toContain("You have no workflows");
    fail = false;
    await act(async () => { [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Try again")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("[data-workflow-slot]")?.textContent).toContain("Morning round");
  });

  it("moves focus to Remove after Use, and to the slot after Remove", async () => {
    const container = mount(slot());
    const render = (next: WhatItDoesWorkflow) => act(() => root!.render(createElement(WhatItDoes, { value: "", onChange: vi.fn(), placeholder: "p", label: "What it does", workflow: next })));
    await settle();
    click(byLabel(container, "Use Morning round"));
    render(slot({ choice: { mode: "workflow", id: "wf1" } }));
    expect(document.activeElement).toBe(byLabel(container, "Stop using Morning round"));
    click(byLabel(container, "Stop using Morning round"));
    render(slot());
    expect(document.activeElement).toBe(container.querySelector("[data-workflow-slot]"));
    expect(container.querySelector("[data-workflow-slot]")?.getAttribute("tabindex")).toBe("-1");
  });
});
