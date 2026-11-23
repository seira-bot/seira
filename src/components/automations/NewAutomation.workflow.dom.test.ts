// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, bots: [bot], selectedId: bot.id }, dispatch: fixture.dispatch }),
  };
});

import { NewAutomation } from "./NewAutomation";

const bot: Bot = {
  id: "wf-bot", threadId: "wf-thread", name: "Atlas", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "",
  modelSelection: { instanceId: "claude", model: "fake" },
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const drawButton = () => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Draw a workflow instead");

describe("New automation box: draw a workflow", () => {
  it("closes the box and asks the page to create a workflow", () => {
    const onClose = vi.fn();
    const onDrawWorkflow = vi.fn();
    flushSync(() => root.render(createElement(NewAutomation, { onClose, onSetUpYourself: vi.fn(), onDrawWorkflow })));
    flushSync(() => drawButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDrawWorkflow).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows no such button when the page cannot draw workflows", () => {
    flushSync(() => root.render(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself: vi.fn() })));
    expect(drawButton()).toBeUndefined();
  });
});
