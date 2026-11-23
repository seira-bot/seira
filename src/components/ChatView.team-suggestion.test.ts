// @vitest-environment happy-dom
// The suggested team under Seira's line: edit, untick, rename, Create team, then the intro with a first task.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { suggestionPackage } from "../../shared/team-suggestion";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");

const document = suggestionPackage({
  department: "Bakery", summary: "A team for a bakery.",
  bots: [{ name: "Baker", role: "Orders", job: "Tracks the daily orders." }, { name: "Books", role: "Bookkeeper", job: "Keeps the weekly books." }, { name: "Post", role: "Social", job: "Writes the weekly post." }],
  groupChats: [{ name: "Huddle", members: ["Baker", "Books", "Post"] }],
});
const at = new Date(2026, 9, 3, 9, 0).getTime();
const card: Message = { id: "c1", role: "bot", kind: "text", at, text: "Here is a team.", teamSuggestion: { document: document as unknown as Record<string, unknown>, firstTask: "Plan this week's orders", state: "open" } };
const intro: Message = { id: "i1", parentId: "c1", role: "bot", kind: "text", at: at + 1, text: "Your team is ready.", teamIntro: { department: "Corner Bakery", bots: [{ id: "b1", name: "Baker", job: "Tracks the daily orders." }], firstTask: "Plan this week's orders" } };
const profile = (messages: Message[]): Bot => ({
  id: "seira", threadId: "seira-thread", name: "Seira", title: "", description: "", soul: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)!.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "seira-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
});

const sent: Array<{ url: string; init?: RequestInit }> = [];
const dispatch = vi.fn();
let reply: unknown = { bots: [] };
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(bot: Bot) {
  const state: AppState = {
    ...initialState, connected: true, selectedId: bot.id, bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, capabilities: { agentsMcp: true } } as InstanceInfo],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await settle();
}
const section = () => globalThis.document.querySelector<HTMLElement>("[data-team-card]");
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
};

beforeAll(() => {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }));
  });
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("the suggested team card", () => {
  it("creates only the kept, renamed bots in the edited department", async () => {
    await draw(profile([card]));
    expect(section()?.textContent).toContain("Tracks the daily orders.");
    const boxes = [...section()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(3);
    flushSync(() => boxes[2]!.click());
    const fields = [...section()!.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')];
    type(fields[0]!, "Corner Bakery");
    type(fields[2]!, "Ledger");
    const added = { id: "b1", name: "Baker" };
    reply = { bots: [added], intro };
    sent.length = 0;
    flushSync(() => section()!.querySelector<HTMLButtonElement>("[data-team-create]")!.click());
    await settle();
    const call = sent.find((entry) => entry.url.endsWith("/api/teams/suggestion/c1"));
    const body = JSON.parse(String(call?.init?.body)) as { threadId: string; keep: string[]; names: Record<string, string>; department: string };
    expect(body).toMatchObject({ threadId: "seira-thread", department: "Corner Bakery" });
    expect(body.keep).toHaveLength(2);
    expect(Object.values(body.names)).toContain("Ledger");
    expect(dispatch).toHaveBeenCalledWith({ type: "botAdded", bot: added, preserveSelection: true });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "select" }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "messageAdded", message: intro }));
  });

  it("skips without creating, and shows a settled card as read-only text", async () => {
    await draw(profile([card]));
    sent.length = 0;
    reply = { ok: true };
    flushSync(() => section()!.querySelector<HTMLButtonElement>("[data-team-skip]")!.click());
    await settle();
    expect(sent.some((entry) => entry.url.endsWith("/api/teams/suggestion/c1/skip"))).toBe(true);
    await draw(profile([{ ...card, teamSuggestion: { ...card.teamSuggestion!, state: "replaced" } }]));
    expect(section()?.querySelector("[data-team-create]")).toBeNull();
    expect(section()?.querySelector("[data-team-state]")?.textContent).toBe("Replaced by a newer suggestion.");
  });
});

describe("the team intro", () => {
  it("names each bot's job, says how to ask, and sends the first task from its chip", async () => {
    await draw(profile([intro]));
    const part = globalThis.document.querySelector<HTMLElement>("[data-team-intro]")!;
    expect(part.textContent).toContain("Baker - Tracks the daily orders.");
    expect(part.textContent).toContain("ask me, and I'll pass the work on");
    dispatch.mockClear();
    flushSync(() => part.querySelector<HTMLButtonElement>("[data-team-first-task]")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "send", botId: "seira", text: "Plan this week's orders", threadId: "seira-thread" });
  });
});
