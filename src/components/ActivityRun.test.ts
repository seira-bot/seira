import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ bots: [] as Bot[] }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: vi.fn() }) };
});
vi.mock("./Avatar", () => ({ BotAvatar: ({ bot }: { bot: Bot }) => createElement("i", { "data-avatar": bot.id }) }));

const { ActivityRun } = await import("./ActivityRun");
const { ActivityStepLine } = await import("./ActivityStepLine");

const bot = (id: string, name: string): Bot => ({
  id, threadId: `thread-${id}`, name, title: "", description: "", soul: "", notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
});
const step = (id: string, extra: Partial<Message> = {}): Message =>
  ({ id, at: 1, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, summary: "ls" }, ...extra }) as Message;
const peer = (id: string, withBotId: string): Message =>
  step(id, { comm: { groupId: "g", withBotId, withName: withBotId, withColor: "blue" } });

fixture.bots = ["a", "b", "c", "d", "e", "f"].map((id) => bot(id, id.toUpperCase()));
const run = (props: Partial<Parameters<typeof ActivityRun>[0]>, messages = [step("s1")]) =>
  renderToStaticMarkup(createElement(ActivityRun, { messages, children: null, ...props }));

describe("ActivityRun in Simple mode", () => {
  it("is closed by default, with a check, the step summary and a chevron", () => {
    const html = run({ botId: "a" });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1 step · Run a command");
    expect(html).toContain("text-success");
    expect(html).not.toContain("data-step-list");
  });

  it("shows the duration in short form", () => {
    expect(run({ botId: "a", durationMs: 18_000 })).toContain(">18s<");
    expect(run({ botId: "a", durationMs: 125_000 })).toContain(">2m 05s<");
    expect(run({ botId: "a" })).not.toContain("data-run-duration");
    expect(run({ botId: "a", durationMs: 400 })).not.toContain("data-run-duration");
  });

  it("shows the chat's bot first, then the bots it talked to, at most four", () => {
    const peers = ["b", "c", "b", "d", "e", "f"].map((id, i) => peer(`p${i}`, id));
    const html = run({ botId: "a" }, peers);
    expect([...html.matchAll(/data-avatar="(\w)"/g)].map((match) => match[1])).toEqual(["a", "b", "c", "d"]);
  });

  it("shows only the chat's bot when no step talks to another bot", () => {
    expect([...run({ botId: "a" }).matchAll(/data-avatar="(\w)"/g)].map((match) => match[1])).toEqual(["a"]);
  });

  it("opens to one line per step with the bot's name, the step text and a mark", () => {
    const messages = [step("s1"), peer("s3", "b"), step("s2", { tool: { name: "Bash", ok: false } })];
    const lines = messages.map((message) => createElement(ActivityStepLine, { key: message.id, message, botId: "a" }));
    const html = run({ botId: "a", forceOpen: true, children: lines }, messages);
    expect(html).toContain("data-step-list");
    expect(html.match(/data-activity-step/g)).toHaveLength(3);
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
    expect(html).toContain("Run a command");
    expect(html.match(/data-step-mark="done"/g)).toHaveLength(2);
    expect(html.match(/data-step-mark="failed"/g)).toHaveLength(1);
  });

  it("draws the chip in a step line that has no tool", () => {
    const note = step("n", { tool: undefined, text: "note" });
    const html = renderToStaticMarkup(createElement(ActivityStepLine, { message: note, botId: "a" }, createElement("b", null, "chip")));
    expect(html).toContain("<b>chip</b>");
  });
});
