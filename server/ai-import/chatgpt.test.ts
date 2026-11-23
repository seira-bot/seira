import { describe, expect, it } from "vitest";

import type { ImportConversation, ImportEvent } from "../../shared/ai-import/bundle.ts";
import { chatgptReader } from "./chatgpt.ts";
import { claudeAiReader } from "./claude-ai.ts";
import { collectEvents, fixtureFiles, memFiles, prefixed, spyFiles } from "./fixtures/files-helpers.ts";

const LAYOUTS = ["single", "numbered", "parts"] as const;

const withoutProgress = (events: ImportEvent[]): ImportEvent[] => events.filter((event) => event.type !== "progress");

function conversations(events: ImportEvent[]): ImportConversation[] {
  return events.flatMap((event) => (event.type === "conversation" ? [event.conversation] : []));
}

async function readLayout(layout: string): Promise<ImportEvent[]> {
  return collectEvents(chatgptReader, await fixtureFiles("chatgpt", layout));
}

function chat(id: string, mapping: Record<string, unknown>, current: string): string {
  return JSON.stringify({ title: id, conversation_id: id, current_node: current, mapping });
}

const node = (id: string, parent: string | null, message: unknown) => ({ id, parent, message, children: [] });
const say = (id: string, role: string, text: string) => ({ id, author: { role }, create_time: 1, weight: 1, metadata: {}, recipient: "all", content: { content_type: "text", parts: [text] } });

describe("ChatGPT reader", () => {
  it("three layouts, one bundle", async () => {
    const [single, numbered, parts] = await Promise.all(LAYOUTS.map(readLayout));
    expect(withoutProgress(numbered)).toEqual(withoutProgress(single));
    expect(withoutProgress(parts)).toEqual(withoutProgress(single));
    expect(conversations(single).map((conversation) => conversation.ref)).toEqual(["c1", "c2"]);
  });

  it("emits the source, one agent and then the conversations", async () => {
    const events = await readLayout("single");
    expect(events.map((event) => event.type).filter((type) => type !== "progress")).toEqual(["source", "agent", "conversation", "conversation", "leftover"]);
    const source = events[0];
    expect(source.type === "source" && source.source.kind).toBe("chatgpt");
    const agent = events.find((event) => event.type === "agent");
    expect(agent?.type === "agent" && agent.agent.name).toBe("ChatGPT");
  });

  it("active branch", async () => {
    const [c1] = conversations(await readLayout("single"));
    expect(c1.activeLeafRef).toBe("a2");
    const byRef = new Map(c1.messages.map((message) => [message.ref, message]));
    const chain: string[] = [];
    for (let at: string | null = c1.activeLeafRef; at !== null; at = byRef.get(at)?.parentRef ?? null) chain.unshift(at);
    expect(chain).toEqual(["u1", "a1b", "u2", "a2"]);
    expect(chain.map((ref) => byRef.get(ref)?.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const times = chain.map((ref) => byRef.get(ref)?.at as number);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(byRef.get("u1")?.at).toBe(1_700_000_100_000);
  });

  it("stored branches", async () => {
    const [c1] = conversations(await readLayout("single"));
    const old = c1.messages.find((message) => message.ref === "a1");
    expect(old).toMatchObject({ parentRef: "u1", role: "assistant" });
    expect(old?.text).toContain("Day 1: Alfama.");
  });

  it("hidden messages", async () => {
    const [c1] = conversations(await readLayout("single"));
    const text = c1.messages.map((message) => message.text).join("\n");
    expect(text).not.toContain("HIDDEN MESSAGE");
    expect(text).not.toContain("private reasoning");
    expect(text).not.toContain("42");
    expect(c1.messages.map((message) => message.ref)).not.toContain("h");
  });

  it("unknown content type", async () => {
    const [c1] = conversations(await readLayout("single"));
    expect(c1.messages.find((message) => message.ref === "a2")?.text).toBe("It looks like a tram.");
  });

  it("keeps a missing title and time as defaults", async () => {
    const [, c2] = conversations(await readLayout("single"));
    expect(c2).toMatchObject({ ref: "c2", title: "New chat", createdAt: null });
    expect(c2.messages[0]).toMatchObject({ ref: "u", at: null, parentRef: null });
  });

  it("broken conversation", async () => {
    const events = await readLayout("single");
    expect(events.filter((event) => event.type === "leftover")).toEqual([
      { type: "leftover", leftover: { ref: "conversation-3", kind: "conversation", name: "Broken one", reason: "unreadable" } },
    ]);
    const text = `[{"title":"bad","mapping":{"a": oops}}, ${chat("ok", { r: node("r", null, null), u: node("u", "r", say("u", "user", "Hi")) }, "u")}]`;
    const result = await collectEvents(chatgptReader, memFiles({ "conversations.json": text }));
    expect(result.filter((event) => event.type === "leftover")).toEqual([{ type: "leftover", leftover: { ref: "conversation-1", kind: "conversation", reason: "unreadable" } }]);
    expect(conversations(result).map((conversation) => conversation.ref)).toEqual(["ok"]);
  });

  it("skips chat.html", async () => {
    const spy = spyFiles(await fixtureFiles("chatgpt", "single"));
    await collectEvents(chatgptReader, spy.files);
    expect(spy.opened).toEqual(["conversations.json"]);
    expect(await chatgptReader.sniff(spy.files)).toBe(true);
    expect(spy.opened).not.toContain("chat.html");
    expect(spy.opened).not.toContain("user.json");
  });

  it("maps custom instructions and stays silent without them", async () => {
    const events = await readLayout("single");
    const agent = events.find((event) => event.type === "agent");
    expect(agent?.type === "agent" && agent.agent.aboutYou).toEqual([{ ref: "about-you", text: "I live in Porto and cook a lot." }]);
    expect(agent?.type === "agent" && agent.agent.howToReply).toEqual([{ ref: "how-to-reply", text: "Answer in short sentences." }]);
    const plain = await collectEvents(chatgptReader, memFiles({ "conversations.json": `[${chat("p", { r: node("r", null, null), u: node("u", "r", say("u", "user", "Hi")) }, "u")}]` }));
    const plainAgent = plain.find((event) => event.type === "agent");
    expect(plainAgent?.type === "agent" && [plainAgent.agent.aboutYou, plainAgent.agent.howToReply]).toEqual([[], []]);
  });

  it("maps assets to attachments by entry", async () => {
    const [c1] = conversations(await readLayout("single"));
    const attachments = (ref: string) => c1.messages.find((message) => message.ref === ref)?.attachments;
    expect(attachments("u2")).toEqual([
      { ref: "file-AbC123", name: "photo.png", entry: "file-AbC123-photo.png", size: 2048 },
      { ref: "file_00000000aaaa", name: "notes.txt", mime: "text/plain", entry: "file_00000000aaaa-notes.txt", size: 12 },
    ]);
    expect(attachments("a1")).toEqual([{ ref: "file-DaLle99", name: "0d5c1e.webp", entry: "dalle-generations/file-DaLle99-0d5c1e.webp", size: 4096 }]);
  });

  it("notes an asset that the export does not hold", async () => {
    const message = { ...say("u", "user", "See"), content: { content_type: "multimodal_text", parts: ["See", { content_type: "image_asset_pointer", asset_pointer: "file-service://file-Gone000" }] } };
    const files = memFiles({ "conversations.json": `[${chat("x", { r: node("r", null, null), u: node("u", "r", message) }, "u")}]` });
    const [conversation] = conversations(await collectEvents(chatgptReader, files));
    expect(conversation.messages[0]).toMatchObject({ attachments: [{ ref: "file-Gone000", missing: true }], notes: [{ kind: "file-not-in-export", name: "file-Gone000" }] });
  });

  it("lists a numbered file that the manifest names but the upload lacks", async () => {
    const one = `[${chat("a", { r: node("r", null, null), u: node("u", "r", say("u", "user", "Hi")) }, "u")}]`;
    const files = memFiles({
      "conversations-000.json": one,
      "export_manifest.json": JSON.stringify({ export_files: [{ path: "conversations-000.json" }, { path: "conversations-001.json" }] }),
    });
    const events = await collectEvents(chatgptReader, files);
    expect(events.filter((event) => event.type === "leftover")).toEqual([{ type: "leftover", leftover: { ref: "conversations-001.json", kind: "file", name: "conversations-001.json", reason: "not-in-export" } }]);
  });

  it("reads conversations-0.json, -1 and -10 in number order", async () => {
    const make = (id: string) => `[${chat(id, { r: node("r", null, null), u: node("u", "r", say("u", "user", id)) }, "u")}]`;
    const files = memFiles({ "conversations-10.json": make("ten"), "conversations-1.json": make("one"), "conversations-0.json": make("zero") });
    expect(conversations(await collectEvents(chatgptReader, files)).map((conversation) => conversation.ref)).toEqual(["zero", "one", "ten"]);
  });

  it("skips a conversation that nests deeper than 64 levels", async () => {
    const deep = `${"[".repeat(70)}${"]".repeat(70)}`;
    const ok = chat("ok", { r: node("r", null, null), u: node("u", "r", say("u", "user", "Hi")) }, "u");
    const events = await collectEvents(chatgptReader, memFiles({ "conversations.json": `[{"title":"deep","x":${deep}},${ok}]` }));
    expect(events.filter((event) => event.type === "leftover")).toEqual([{ type: "leftover", leftover: { ref: "conversation-1", kind: "conversation", reason: "too-deep" } }]);
    expect(conversations(events)).toHaveLength(1);
  });

  it("skips a conversation with a message over 16 MB", async () => {
    const huge = "x".repeat(17 * 1024 * 1024);
    const ok = chat("ok", { r: node("r", null, null), u: node("u", "r", say("u", "user", "Hi")) }, "u");
    const events = await collectEvents(chatgptReader, memFiles({ "conversations.json": `[${chat("big", { r: node("r", null, null), u: node("u", "r", say("u", "user", huge)) }, "u")},${ok}]` }));
    expect(events.filter((event) => event.type === "leftover")).toEqual([{ type: "leftover", leftover: { ref: "conversation-1", kind: "conversation", reason: "too-large" } }]);
    expect(conversations(events).map((conversation) => conversation.ref)).toEqual(["ok"]);
  });

  it("reports progress in bytes that ends at the total", async () => {
    const events = await readLayout("numbered");
    const progress = events.filter((event) => event.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1);
    expect(last?.type === "progress" && last.unit).toBe("bytes");
    expect(last?.type === "progress" && last.done).toBe(last?.type === "progress" && last.total);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collectEvents(chatgptReader, await fixtureFiles("chatgpt", "single"), controller.signal)).rejects.toThrow();
  });
});

describe("ChatGPT sniff", () => {
  it("names each layout from content, also under a folder", async () => {
    for (const layout of LAYOUTS) {
      const files = await fixtureFiles("chatgpt", layout);
      const started = Date.now();
      expect(await chatgptReader.sniff(files)).toBe(true);
      expect(await chatgptReader.sniff(prefixed(files, "Downloads/my data (3)/"))).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await claudeAiReader.sniff(files)).toBe(false);
    }
  });

  it("does not take a Claude export or an unknown file", async () => {
    expect(await chatgptReader.sniff(await fixtureFiles("claude-ai", "full"))).toBe(false);
    expect(await chatgptReader.sniff(memFiles({ "notes.json": "[]" }))).toBe(false);
    expect(await chatgptReader.sniff(memFiles({ "conversations.json": '[{"a":1}]' }))).toBe(false);
    expect(await chatgptReader.sniff(memFiles({}))).toBe(false);
  });

  it("takes an empty list only when other ChatGPT files sit beside it", async () => {
    expect(await chatgptReader.sniff(memFiles({ "conversations.json": "[]", "chat.html": "<html>" }))).toBe(true);
    expect(await chatgptReader.sniff(memFiles({ "conversations.json": "[]" }))).toBe(false);
  });
});
