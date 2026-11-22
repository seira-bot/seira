// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");

const NOW = new Date(2026, 10, 22, 9, 0).getTime();
const task = (threadId: string, title: string, extra: Record<string, unknown> = {}) => ({
  threadId, title, createdAt: NOW - 3 * 86_400_000, busy: false, activity: "idle" as const,
  modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" as const, ...extra,
});
const summary: Message = {
  id: "c1", role: "bot", kind: "compaction", at: NOW - 1_000,
  compaction: { summary: "The user wants X.", firstKeptId: "", foldedThroughId: "old", tokensBefore: 1, by: "harness" },
};
const bot = (extra: Partial<Bot> = {}): Bot => ({
  id: "pepper", threadId: "work", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [task("work", "Work")], ...extra,
});

let state: AppState;
const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(current: Bot) {
  state = {
    ...initialState, connected: true, selectedId: current.id, bots: [current],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: { showToolCalls: true } } as AppState["config"],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: current }) })));
  await settle();
}

beforeAll(() => {
  setLocale("en");
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
beforeEach(() => dispatch.mockClear());
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("an empty chat", () => {
  it("links to the bot's other open chat that has messages in it, and the link opens it", async () => {
    await draw(bot({ tasks: [task("work", "Work", { updatedAt: NOW - 3 * 86_400_000 }), task("older", "Invoice run", { updatedAt: NOW - 3_600_000 })] }));
    const link = document.querySelector<HTMLButtonElement>("[data-testid=continue-thread]");
    expect(link?.textContent).toBe("Continue in Invoice run");
    flushSync(() => link!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "pepper", threadId: "older" });
  });

  it("shows no link when no other chat has messages in it", async () => {
    await draw(bot({ tasks: [task("work", "Work"), task("blank", "Blank")] }));
    expect(document.querySelector("[data-testid=continue-thread]")).toBeNull();
  });
});

describe("the new chat button under a summary", () => {
  it("starts the new chat as a continuation of the chat it is in", async () => {
    await draw(bot({ messages: [summary], activeLeafId: "c1" }));
    const button = document.querySelector<HTMLButtonElement>("[data-testid=new-chat-hint] button");
    expect(button).not.toBeNull();
    flushSync(() => button!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "newTask", botId: "pepper", continueFrom: "work" });
  });
});

describe("the handoff line of a continued chat", () => {
  const handoff: Message = {
    id: "h1", role: "user", kind: "text", at: NOW - 2_000, handoff: { threadId: "older", title: "Invoice run" },
    text: '[From Seira · continued chat · not from the person. This chat continues "Invoice run".]\nEarlier conversation summary: ALPHA_REQUEST',
  };

  it("is a folded card with the summary and no note line, not a message bubble", async () => {
    await draw(bot({ messages: [handoff], activeLeafId: "h1" }));
    const card = document.querySelector("[data-testid=handoff-card]");
    expect(card?.tagName).toBe("DETAILS");
    expect(card?.querySelector("summary")?.textContent).toBe("Summary of «Invoice run»");
    expect(card?.textContent).toContain("ALPHA_REQUEST");
    expect(card?.textContent).not.toContain("From Seira");
    expect(document.body.textContent).not.toContain("[From Seira");
  });
});
