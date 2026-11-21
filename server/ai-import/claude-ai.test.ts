import { describe, expect, it } from "vitest";

import type { ImportAgent, ImportConversation, ImportEvent } from "../../shared/ai-import/bundle.ts";
import { chatgptReader } from "./chatgpt.ts";
import { claudeAiReader } from "./claude-ai.ts";
import { collectEvents, fixtureFiles, memFiles, prefixed, spyFiles, without } from "./fixtures/files-helpers.ts";

const agents = (events: ImportEvent[]): ImportAgent[] => events.flatMap((event) => (event.type === "agent" ? [event.agent] : []));
const conversationEvents = (events: ImportEvent[]) => events.flatMap((event) => (event.type === "conversation" ? [event] : []));

async function conversation(ref: string): Promise<ImportConversation> {
  const events = await collectEvents(claudeAiReader, await fixtureFiles("claude-ai", "full"));
  return conversationEvents(events).find((event) => event.conversation.ref === ref)?.conversation as ImportConversation;
}

describe("Claude.ai reader", () => {
  it("project becomes a bot", async () => {
    const events = await collectEvents(claudeAiReader, await fixtureFiles("claude-ai", "full"));
    const [launch, empty, claude] = agents(events);
    expect(launch).toMatchObject({ ref: "project-p1", name: "Launch plan", persona: "Write in short sentences.", topics: [{ title: "brief.md", text: "# Brief\nShip Friday." }] });
    expect(launch.memories.map((item) => item.text)).toEqual(["Launch is on Friday."]);
    expect(empty).toMatchObject({ ref: "project-p2", name: "Empty project", topics: [] });
    expect(empty.persona).toBeUndefined();
    expect(claude).toMatchObject({ ref: "claude", name: "Claude" });
    expect(claude.memories.map((item) => item.text)).toEqual(["Likes short answers."]);
    const home = Object.fromEntries(conversationEvents(events).map((event) => [event.conversation.ref, event.agentRef]));
    expect(home).toEqual({ "conv-1": "claude", "conv-2": "project-p1" });
    expect(events[0]).toMatchObject({ type: "source", source: { kind: "claude-ai" } });
  });

  it("active leaf", async () => {
    const c1 = await conversation("conv-1");
    expect(c1.activeLeafRef).toBe("m5");
    const byRef = new Map(c1.messages.map((message) => [message.ref, message]));
    const chain: string[] = [];
    for (let at: string | null = c1.activeLeafRef; at !== null; at = byRef.get(at)?.parentRef ?? null) chain.unshift(at);
    expect(chain).toEqual(["m1", "m3", "m4", "m5"]);
    expect(byRef.get("m2")).toMatchObject({ parentRef: "m1", text: "Old answer" });
    expect(byRef.get("m1")?.at).toBe(Date.parse("2026-03-01T10:00:00.000000Z"));
  });

  it("follows a linear chat that has no parent links", async () => {
    const c2 = await conversation("conv-2");
    expect(c2.activeLeafRef).toBe("n2");
    expect(c2.messages.map((message) => [message.ref, message.parentRef, message.role])).toEqual([
      ["n1", null, "user"],
      ["n2", "n1", "assistant"],
    ]);
  });

  it("no double text", async () => {
    const c1 = await conversation("conv-1");
    const byRef = new Map(c1.messages.map((message) => [message.ref, message]));
    expect(byRef.get("m1")?.text).toBe("Hello");
    expect(byRef.get("m5")?.text).toBe("Final answer");
  });

  it("thinking stays out", async () => {
    const c1 = await conversation("conv-1");
    const text = c1.messages.map((message) => message.text).join("\n");
    expect(text).not.toContain("secret reasoning");
    expect(text).not.toContain("TOOL RESULT TEXT");
    expect(c1.messages.find((message) => message.ref === "m5")?.notes).toEqual([{ kind: "tool-call", name: "web_search" }]);
  });

  it("missing file note", async () => {
    const c1 = await conversation("conv-1");
    const m4 = c1.messages.find((message) => message.ref === "m4");
    expect(m4?.text).toContain("Brief: ship Friday");
    expect(m4?.attachments).toEqual([
      { ref: "m4:attachment-1", name: "brief.txt", mime: "text/plain", size: 20 },
      { ref: "f-111", name: "chart.png", missing: true },
    ]);
    expect(m4?.notes).toEqual([{ kind: "file-not-in-export", name: "chart.png" }]);
  });

  it("points a file to its entry when the export holds it", async () => {
    const files = memFiles({
      "conversations.json": JSON.stringify([{ uuid: "c", name: "n", chat_messages: [{ uuid: "m", sender: "human", text: "see", files: [{ file_uuid: "f-9", file_name: "a.png" }] }] }]),
      "f-9-a.png": "png",
    });
    const [event] = conversationEvents(await collectEvents(claudeAiReader, files));
    expect(event.conversation.messages[0].attachments).toEqual([{ ref: "f-9", name: "a.png", entry: "f-9-a.png", size: 3 }]);
  });

  it("reads memories.json only when it exists and never opens users.json", async () => {
    const full = spyFiles(await fixtureFiles("claude-ai", "full"));
    await collectEvents(claudeAiReader, full.files);
    expect(full.opened).toContain("memories.json");
    expect(full.opened).not.toContain("users.json");

    const bare = spyFiles(without(await fixtureFiles("claude-ai", "full"), "memories.json"));
    const events = await collectEvents(claudeAiReader, bare.files);
    expect(bare.opened).not.toContain("memories.json");
    expect(agents(events).map((agent) => agent.ref)).toEqual(["project-p1", "project-p2", "claude"]);
    expect(agents(events).at(-1)?.memories).toEqual([]);
  });

  it("makes the default bot only when a conversation needs it", async () => {
    const files = memFiles({
      "conversations.json": JSON.stringify([{ uuid: "c", name: "n", project_uuid: "p1", chat_messages: [{ uuid: "m", sender: "human", text: "hi" }] }]),
      "projects.json": JSON.stringify([{ uuid: "p1", name: "P", prompt_template: "x", docs: [] }]),
    });
    const events = await collectEvents(claudeAiReader, files);
    expect(agents(events).map((agent) => agent.ref)).toEqual(["project-p1"]);
  });

  it("leaves out a broken conversation and continues", async () => {
    const ok = JSON.stringify({ uuid: "ok", name: "ok", chat_messages: [{ uuid: "m", sender: "human", text: "hi" }] });
    const events = await collectEvents(claudeAiReader, memFiles({ "conversations.json": `[{"uuid":"bad","chat_messages":oops}, {"uuid":"worse","name":"Worse"}, ${ok}]` }));
    expect(events.filter((event) => event.type === "leftover")).toEqual([
      { type: "leftover", leftover: { ref: "conversation-1", kind: "conversation", reason: "unreadable" } },
      { type: "leftover", leftover: { ref: "conversation-2", kind: "conversation", name: "Worse", reason: "unreadable" } },
    ]);
    expect(conversationEvents(events).map((event) => event.conversation.ref)).toEqual(["ok"]);
  });

  it("reports progress in bytes that ends at the total", async () => {
    const events = await collectEvents(claudeAiReader, await fixtureFiles("claude-ai", "full"));
    const last = events.filter((event) => event.type === "progress").at(-1);
    expect(last).toMatchObject({ unit: "bytes" });
    expect(last?.type === "progress" && last.done).toBe(last?.type === "progress" && last.total);
  });
});

describe("Claude.ai sniff", () => {
  it("names the export from content, also under a folder", async () => {
    const files = await fixtureFiles("claude-ai", "full");
    const started = Date.now();
    expect(await claudeAiReader.sniff(files)).toBe(true);
    expect(await claudeAiReader.sniff(prefixed(files, "Downloads/claude data/"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await chatgptReader.sniff(files)).toBe(false);
  });

  it("takes projects and users files without conversations, and refuses others", async () => {
    expect(await claudeAiReader.sniff(memFiles({ "projects.json": "[]", "users.json": "[]" }))).toBe(true);
    expect(await claudeAiReader.sniff(memFiles({ "users.json": "[]" }))).toBe(false);
    expect(await claudeAiReader.sniff(memFiles({ "conversations.json": '[{"a":1}]' }))).toBe(false);
    expect(await claudeAiReader.sniff(await fixtureFiles("chatgpt", "single"))).toBe(false);
  });
});
