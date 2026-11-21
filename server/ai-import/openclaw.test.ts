import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportAgent, ImportConversation, ImportEvent } from "../../shared/ai-import/bundle.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { collect, context, copyFixture, localSource, writeOpenclawDatabase } from "./local-fixtures.ts";
import { locateLocalSources } from "./locate.ts";
import { openclawReader } from "./openclaw.ts";

let scratch: string;
let state: string;
let staging: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "seira-ai-import-openclaw-"));
  state = copyFixture("openclaw", join(scratch, ".openclaw"));
  staging = join(scratch, "staging");
  mkdirSync(staging);
});
afterEach(() => removeTempDir(scratch));

const agentOf = (events: ImportEvent[]): ImportAgent => {
  const event = events.find((item) => item.type === "agent");
  if (event?.type !== "agent") throw new Error("no agent");
  return event.agent;
};
const chatsOf = (events: ImportEvent[]): ImportConversation[] => events.flatMap((event) => (event.type === "conversation" ? [event.conversation] : []));
const main = () => localSource("openclaw", join(state, "workspace"), "main", "OpenClaw");

describe("openclawReader", () => {
  it("maps an agent", async () => {
    writeOpenclawDatabase(join(state, "agents", "main", "agent", "openclaw-agent.sqlite"));
    const events = await collect(openclawReader, main(), context(staging));
    const agent = agentOf(events);

    expect(agent.ref).toBe("main");
    expect(agent.persona).toBe("You are Claw, a friendly assistant.\n\n# Identity\nName: Claw\nEmoji: crab");
    expect(agent.aboutYou.map((item) => item.text)).toEqual(["Name: Sam", "Timezone: Europe/Lisbon"]);
    expect(agent.memories.map((item) => item.text)).toEqual(["Sam likes tea", "The project is called Atlas\nand it ships in March"]);
    expect(agent.dailyNotes).toEqual([{ ref: "memory/2026-01-02.md", date: "2026-01-02", text: "Met Alex about the launch." }]);
    expect(agent.topics).toEqual([{ ref: "AGENTS.md", title: "AGENTS.md", text: "Always answer in English." }]);
    expect(agent.skills.map((skill) => skill.name)).toEqual(["summarize"]);
    expect(agent.tools).toEqual([
      { ref: "mcp/fetch", name: "fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"], needsKey: [] },
      { ref: "mcp/search", name: "search", transport: "http", url: "https://mcp.example.test/search", needsKey: ["X-Api-Key"] },
    ]);
    expect(agent.channels).toEqual([{ ref: "channels/telegram", kind: "telegram" }, { ref: "channels/whatsapp", kind: "whatsapp" }]);
    expect(agent.routines).toEqual([
      { ref: "cron/a", name: "Daily news", schedule: "30 6 * * *", prompt: "Read the news." },
      { ref: "cron/b", name: "Every 15", schedule: "every 15m", prompt: "Ping." },
      { ref: "cron/c", name: "One shot", schedule: "2027-02-01T10:00:00.000Z", prompt: "File taxes." },
      { ref: "HEARTBEAT.md", name: "Heartbeat", schedule: "every 1h", prompt: "# Heartbeat\n- Check the inbox for urgent mail" },
    ]);
    expect(JSON.stringify(events)).not.toContain("synthetic");

    const chats = chatsOf(events);
    expect(chats.map((chat) => chat.ref)).toEqual(["db-1", "old-1"]);
    expect(chats[0]).toMatchObject({ title: "Tea order", createdAt: 1767340800000 });
    expect(chats[0]?.messages.map((message) => [message.ref, message.role, message.text])).toEqual([["dm1", "user", "Order green tea"], ["dm2", "assistant", "Done, one box."]]);
    expect(chats[0]?.messages[1]?.notes).toEqual([{ kind: "tool-call", name: "shop" }]);
  });

  it("half-written line: skips it and keeps the other lines, as a tree by id and parentId", async () => {
    writeFileSync(join(state, "sessions", "old-1.jsonl"), `${[
      '{"type":"session","id":"root"}',
      "{not json at all",
      '{"type":"message","id":"m1","parentId":"root","message":{"role":"user","content":"Hello"}}',
      '{"type":"message","id":"m2","parentId":"m1","message":{"role":"assistant","content":"Hi"}}',
      '{"type":"message","id":"m2b","parentId":"m1","message":{"role":"assistant","content":"Hi again"}}',
      '{"type":"message","id":"m3","parentId":"m2","message":{"role":"toolResult","content":"x"}}',
      '{"type":"message","id":"m4","parentId":"m3","message":{"role":"user","content":"Bye"}}',
    ].join("\n")}\n{"type":"message","id":"m5","parentId":"m4","message":{"role":"assis`);
    const [chat] = chatsOf(await collect(openclawReader, main(), context(staging)));
    expect(chat?.messages.map((message) => [message.ref, message.parentRef])).toEqual([["m1", null], ["m2", "m1"], ["m2b", "m1"], ["m4", "m2"]]);
    expect(chat?.activeLeafRef).toBe("m4");
    expect(chat?.title).toBe("Hello");
  });

  it("reads the fixture session even though its last line is cut off", async () => {
    const [chat] = chatsOf(await collect(openclawReader, main(), context(staging)));
    expect(chat?.ref).toBe("old-1");
    expect(chat?.messages.map((message) => message.ref)).toEqual(["m1", "m2", "m2x", "m4"]);
    expect(chat?.messages[1]?.notes).toEqual([{ kind: "tool-call", name: "web_search" }]);
    expect(chat?.createdAt).toBe(Date.parse("2026-01-02T10:00:01Z"));
  });

  it("old names: imports from a state folder that uses an old name", async () => {
    const old = join(scratch, "home");
    mkdirSync(old);
    renameSync(state, join(old, ".clawdbot"));
    renameSync(join(old, ".clawdbot", "openclaw.json"), join(old, ".clawdbot", "clawdbot.json"));
    const sources = await locateLocalSources({}, old);
    expect(sources.map((source) => source.profile)).toEqual(["main", "ops"]);
    const events = await collect(openclawReader, sources[0]!, context(staging));
    expect(agentOf(events).tools).toHaveLength(2);
    expect(chatsOf(events)).toHaveLength(1);
  });

  it("maps a second agent with its own persona and routines only", async () => {
    const ops = localSource("openclaw", join(state, "workspace-ops"), "ops", "OpenClaw · ops");
    const agent = agentOf(await collect(openclawReader, ops, context(staging)));
    expect(agent.ref).toBe("ops");
    expect(agent.persona).toBe("You are the Ops agent.");
    expect(agent.routines).toEqual([{ ref: "cron/d", name: "Ops job", schedule: "0 0 * * 1", prompt: "Weekly report." }]);
  });

  it("an unreadable config leaves the tools and channels behind", async () => {
    writeFileSync(join(state, "openclaw.json"), "{ mcp: { servers: ");
    const events = await collect(openclawReader, main(), context(staging));
    const agent = agentOf(events);
    expect(agent.tools).toEqual([]);
    expect(agent.channels).toEqual([]);
    expect(agent.persona).toContain("Claw");
    expect(events.flatMap((event) => (event.type === "leftover" ? [[event.leftover.kind, event.leftover.reason]] : []))).toEqual([["tool", "unreadable"], ["channel", "unreadable"]]);
  });

  it("a database that cannot be opened is listed as locked", async () => {
    const path = join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not a database, only some long enough text to be odd");
    const events = await collect(openclawReader, main(), context(staging));
    expect(events.some((event) => event.type === "leftover" && event.leftover.reason === "locked")).toBe(true);
    expect(chatsOf(events).map((chat) => chat.ref)).toEqual(["old-1"]);
  });
});
