// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: vi.fn(async () => ({ hits: [] })),
    useStore: () => ({ state: { ...original.initialState, bots: [bot], groups: [room] }, dispatch: fixture.dispatch }),
  };
});

import { CommandPalette, openCommandPalette } from "./CommandPalette";

const bot: Bot = {
  id: "bot-a", threadId: "thread-a", name: "Atlas", title: "Research", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "",
  modelSelection: { instanceId: "claude", model: "fake" },
};
const room = { id: "room-a", name: "Launch", memberIds: [bot.id] } as unknown as Group;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(CommandPalette)));
  flushSync(() => openCommandPalette());
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const press = (key: string) => flushSync(() => document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

describe("the command palette look", () => {
  it("is a 560px dialog with a 52px input row and a footer of three key hints", () => {
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain("max-w-[560px]");
    expect(document.querySelector("input")!.parentElement!.className).toContain("h-[52px]");
    const foot = document.querySelector("[data-palette-foot]")!;
    expect([...foot.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["↑↓", "↵", "esc"]);
    expect(foot.textContent).toContain("move");
    expect(foot.textContent).toContain("open");
    expect(foot.textContent).toContain("close");
  });

  it("marks the active row ink/6% and moves it with the arrow keys, then opens it with Enter", () => {
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    expect(rows()[0]!.className).toContain("bg-ink/[0.06]");
    expect(rows()[1]!.className).not.toContain("bg-ink/[0.06]");
    press("ArrowDown");
    expect(rows()[1]!.className).toContain("bg-ink/[0.06]");
    press("Enter");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "select", id: "room-a" });
  });

  it("puts focus back on the control that opened it when it closes", () => {
    flushSync(() => root.unmount());
    root = createRoot(host);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    flushSync(() => root.render(createElement(CommandPalette)));
    flushSync(() => openCommandPalette());
    expect(document.activeElement).toBe(document.querySelector("input"));
    press("Escape");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("reads its input in the direction of what is typed", () => {
    expect(document.querySelector("input")!.getAttribute("dir")).toBe("auto");
  });

  it("closes on Escape", () => {
    press("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
