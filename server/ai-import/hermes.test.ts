import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportAgent, ImportConversation, ImportEvent } from "../../shared/ai-import/bundle.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { hermesReader } from "./hermes.ts";
import { collect, context, copyFixture, localSource, writeHermesDatabase } from "./local-fixtures.ts";

let scratch: string;
let home: string;
let staging: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "seira-ai-import-hermes-"));
  home = copyFixture("hermes", join(scratch, "home"));
  staging = join(scratch, "staging");
  mkdirSync(staging);
});
afterEach(() => removeTempDir(scratch));

const agentOf = (events: ImportEvent[]): ImportAgent => {
  const event = events.find((item) => item.type === "agent");
  if (event?.type !== "agent") throw new Error("no agent");
  return event.agent;
};
const conversationsOf = (events: ImportEvent[]): ImportConversation[] => events.flatMap((event) => (event.type === "conversation" ? [event.conversation] : []));

describe("hermesReader", () => {
  it("maps a profile", async () => {
    writeHermesDatabase(join(home, "state.db"));
    const events = await collect(hermesReader, localSource("hermes", home, undefined, "Hermes"), context(staging));
    const agent = agentOf(events);

    expect(events[0]).toMatchObject({ type: "source", source: { kind: "hermes" } });
    expect(agent.ref).toBe("default");
    expect(agent.persona).toBe("You are Hermes, a calm helper who answers in short plain sentences.");
    expect(agent.aboutYou.map((item) => item.text)).toEqual(["Name: Sam. Lives in Lisbon.", "Prefers metric units."]);
    expect(agent.memories.map((item) => item.text)).toEqual(["The deploy key rotates every Monday.", 'Staging is called "plum".']);
    expect(agent.skills.map((skill) => skill.ref).sort()).toEqual(["skills/devops/deploy", "skills/pdf-notes"]);
    for (const skill of agent.skills) {
      expect(skill.dir.startsWith(staging)).toBe(true);
      expect(existsSync(join(skill.dir, "SKILL.md"))).toBe(true);
    }
    expect(existsSync(join(agent.skills.find((skill) => skill.name === "deploy")!.dir, "run.sh"))).toBe(true);

    expect(agent.tools).toEqual([
      { ref: "mcp/github", name: "github", transport: "stdio", command: "npx", args: ["-y", "example-github-mcp"], needsKey: ["GITHUB_TOKEN"] },
      { ref: "mcp/docs", name: "docs", transport: "http", url: "https://mcp.example.test/docs", needsKey: ["Authorization"] },
    ]);
    expect(agent.channels.map((channel) => channel.kind)).toEqual(["telegram", "discord"]);
    expect(agent.routines).toEqual([
      { ref: "cron/j1", name: "Morning brief", schedule: "0 7 * * *", prompt: "Summarise my day." },
      { ref: "cron/j2", name: "Water", schedule: "every 2h", prompt: "Remind me to drink water." },
      { ref: "cron/j3", name: "Once", schedule: "2027-01-05T09:00:00.000Z", prompt: "Call the bank." },
      { ref: "cron/j5", name: "Interval", schedule: "every 90m", prompt: "Check mail." },
    ]);
    expect(events.filter((event) => event.type === "leftover").map((event) => event.type === "leftover" && [event.leftover.ref, event.leftover.reason])).toEqual([
      ["mcp/broken", "unsupported"],
      ["cron/j4", "unsupported"],
    ]);

    const chats = conversationsOf(events);
    expect(chats.map((chat) => [chat.ref, chat.title])).toEqual([["s1", "Plan the trip"], ["s2", "Remind me about the bank"]]);
    const [first] = chats;
    expect(first?.messages.map((message) => [message.role, message.text, message.parentRef])).toEqual([
      ["user", "Where should we go?", null],
      ["assistant", "How about Porto?", expect.any(String)],
      ["user", "Sounds good", expect.any(String)],
    ]);
    expect(first?.messages[1]?.notes).toEqual([{ kind: "tool-call", name: "web_search" }]);
    expect(first?.messages[0]?.at).toBe(1767340801000);
    expect(first?.createdAt).toBe(1767340800500);
    expect(first?.activeLeafRef).toBe(first?.messages[2]?.ref);
    expect(events.at(-1)).toMatchObject({ type: "progress", done: 2 });
  });

  it("maps a named profile with its own agent ref", async () => {
    const work = join(home, "profiles", "work");
    const events = await collect(hermesReader, localSource("hermes", work, "work", "Hermes · work"), context(staging));
    expect(events[0]).toMatchObject({ source: { profile: "work" } });
    expect(agentOf(events)).toMatchObject({ ref: "work", persona: "Hermes work profile persona.", memories: [{ text: "Work note one." }] });
  });

  it("locked database: brings in the other parts and lists the chats as left behind", async () => {
    writeFileSync(join(home, "state.db"), "this is not a database file at all, it is long enough to look odd");
    const events = await collect(hermesReader, localSource("hermes", home), context(staging));
    expect(agentOf(events).memories).toHaveLength(2);
    expect(conversationsOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "leftover", leftover: { ref: "state.db", kind: "conversation", name: "state.db", reason: "locked" } });
  });

  it("works without a state database", async () => {
    const events = await collect(hermesReader, localSource("hermes", home), context(staging));
    expect(conversationsOf(events)).toEqual([]);
  });

  it("an unreadable config.yaml leaves the tools and channels behind", async () => {
    writeFileSync(join(home, "config.yaml"), "mcp_servers: [unclosed\n  : :");
    const events = await collect(hermesReader, localSource("hermes", home), context(staging));
    const agent = agentOf(events);
    expect(agent.tools).toEqual([]);
    expect(agent.channels).toEqual([]);
    const kinds = events.flatMap((event) => (event.type === "leftover" ? [event.leftover.kind] : []));
    expect(kinds.slice(0, 2)).toEqual(["tool", "channel"]);
  });

  it("emits no platform token", async () => {
    const events = await collect(hermesReader, localSource("hermes", home), context(staging));
    expect(JSON.stringify(events)).not.toContain("synthetic-");
  });

  it("copies the database into staging and leaves the source folder alone", async () => {
    writeHermesDatabase(join(home, "state.db"));
    const before = readdirSync(home).sort();
    const events = await collect(hermesReader, localSource("hermes", home), context(staging));
    expect(readdirSync(home).sort()).toEqual(before);
    expect(readdirSync(staging)).toContain("hermes-state.db");
    expect(readFileSync(join(home, "state.db")).length).toBeGreaterThan(0);
    expect(conversationsOf(events)).toHaveLength(2);
  });
});
