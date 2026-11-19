// @vitest-environment happy-dom
// Advanced mode's composer: the same card as Simple, with quiet chips for the controls Advanced keeps, a round voice, Send and Stop slot,
// and an approval card above it.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";

const fixture = vi.hoisted(() => ({
  advanced: false,
  admin: true,
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config ?? original.initialState.config, bots: [bot, peer], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: (props: Record<string, unknown>) => {
  fixture.groupCall = props;
  return null;
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [bot.id, peer.id],
  defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages: [],
};

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(Composer, props)));
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');

beforeEach(() => {
  fixture.advanced = true;
  fixture.admin = true;
  fixture.agentsMcp = true;
  fixture.liveCall = null;
  fixture.config = undefined;
  setCallMode("turns");
  fixture.call = null;
  fixture.groupCall = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of [`bot:${bot.id}:${bot.threadId}`, `group:${room.id}:${room.threadId}`]) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});


const slotState = () => container.querySelector("[data-composer-slot]")?.getAttribute("data-composer-slot");
const draft = `bot:${bot.id}:${bot.threadId}`;
const chipLabels = () => [...container.querySelectorAll<HTMLElement>('[data-composer-row] button')].map((button) => button.textContent?.trim()).filter(Boolean);
const approvalMessage = (id: string) => ({
  id, at: 1, role: "bot" as const, kind: "options" as const,
  card: { title: "Approval needed", subtitle: "git status --short", options: ["Allow", "Deny"], tool: "Bash", requestId: id, allowSession: true },
});

describe("the Advanced composer card", () => {
  it("is the card with the field above a bar of quiet 28px chips", () => {
    render({ bot });
    const pill = container.querySelector('[data-tour="composer"]')!.className.split(" ");
    expect(pill).toEqual(expect.arrayContaining(["rounded-[22px]", "bg-composer", "ring-1"]));
    expect(container.querySelector("[data-composer-row]")!.className).toContain("grid");
    expect(container.querySelector('button[aria-label="Attach a file"]')).not.toBeNull();
    const goal = container.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(goal.className.split(" ")).toEqual(expect.arrayContaining(["h-7", "text-[12px]", "font-medium", "rounded-full"]));
    expect(goal.textContent).toBe("Goal");
    expect(container.querySelector("[data-composer-context] button")!.textContent).toMatch(/^Context/);
    expect(container.querySelector("[data-composer-context] button")!.className.split(" ")).toContain("h-7");
  });

  it("turns Goal on and off with aria-pressed", () => {
    render({ bot });
    const goal = container.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(goal.getAttribute("aria-pressed")).toBe("false");
    click(goal);
    expect(container.querySelector("button[aria-pressed]")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("button[aria-pressed]")!.className).toContain("text-accent-text");
  });

  it("keeps the approval level chip and its menu", () => {
    render({ bot });
    const level = container.querySelector<HTMLButtonElement>('button[aria-label^="Approval"], button[aria-haspopup="menu"]')!;
    expect(chipLabels().join(" ")).toMatch(/Ask|Full access|Auto/);
    click(level);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("morphs the round slot: voice when empty, Send with text, Stop while the bot works", () => {
    render({ bot });
    expect(slotState()).toBe("voice");
    restoreComposerDraft(draft, { text: "hello", attachments: [] });
    render({ bot: { ...bot, color: "teal" } });
    expect(slotState()).toBe("send");
    expect(sendButton()!.className.split(" ")).toContain("size-8");
    restoreComposerDraft(draft, { text: "", attachments: [] });
    render({ bot: { ...bot, color: "teal", busy: true } });
    expect(slotState()).toBe("stop");
    const stop = container.querySelector<HTMLButtonElement>('[data-composer-stop="slot"]')!;
    expect(stop.getAttribute("aria-label")).toBe("Stop this turn");
    click(stop);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "interrupt", botId: "atlas", threadId: "atlas-thread" });
  });

  it("sends with Return and keeps a new line on Shift+Return", () => {
    restoreComposerDraft(draft, { text: "hello", attachments: [] });
    render({ bot });
    const input = container.querySelector("textarea")!;
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
    expect(fixture.dispatch).not.toHaveBeenCalled();
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", botId: "atlas", text: "hello" }));
  });

  it("edits the last message with the up arrow in an empty field", () => {
    const onEditLast = vi.fn();
    render({ bot, onEditLast });
    flushSync(() => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
    expect(onEditLast).toHaveBeenCalledOnce();
  });

  it("keeps Simple's + out of the Advanced bar", () => {
    render({ bot });
    expect(container.querySelector("[data-composer-plus]")).toBeNull();
  });
});

describe("the Advanced slash menu", () => {
  it("lists text-only rows and moves with the arrows, Tab and Escape", () => {
    restoreComposerDraft(draft, { text: "/", attachments: [] });
    render({ bot });
    const input = container.querySelector("textarea")!;
    input.setSelectionRange(1, 1);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keyup", { key: "/", bubbles: true })));
    const menu = document.body.querySelector<HTMLElement>('[data-slash-menu="advanced"]')!;
    expect(menu.getAttribute("role")).toBe("listbox");
    expect(menu.querySelector("svg")).toBeNull();
    const rows = () => [...menu.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(rows()[0]!.className.split(" ")).toContain("min-h-11");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    const key = (name: string) => flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
    key("ArrowDown");
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    key("Tab");
    expect(input.value.startsWith("/")).toBe(true);
    expect(input.value.length).toBeGreaterThan(1);
  });

  it("closes on Escape", () => {
    restoreComposerDraft(draft, { text: "/", attachments: [] });
    render({ bot });
    const input = container.querySelector("textarea")!;
    input.setSelectionRange(1, 1);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keyup", { key: "/", bubbles: true })));
    expect(document.body.querySelector('[data-slash-menu="advanced"]')).not.toBeNull();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    flushSync(() => input.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
  });
});

describe("the approval card above the Advanced composer", () => {
  it("answers through the same decision the buttons always sent", () => {
    render({ bot: { ...bot, messages: [approvalMessage("req-1")] } });
    const card = container.querySelector('[data-look="approval-card"]')!;
    expect(card.parentElement!.className).toContain("shadow-(--shadow-float)");
    const named = (label: string) => [...card.querySelectorAll("button")].find((button) => button.textContent === label)!;
    click(named("Deny"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "decideRequest", requestId: "req-1", behavior: "deny" }));
    click(named("Allow once"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "decideRequest", requestId: "req-1", behavior: "allow" }));
  });

  it("shows a position chip only for more than one request", () => {
    render({ bot: { ...bot, messages: [approvalMessage("req-1")] } });
    expect(container.querySelector('[data-look="approval-card"]')!.textContent).not.toMatch(/1 of|1\/2/);
    render({ bot: { ...bot, messages: [approvalMessage("req-1"), approvalMessage("req-2")] } });
    expect(container.querySelector('[data-look="approval-card"]')!.textContent).toMatch(/1.*2/);
  });
});
