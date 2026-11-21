import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportAgent, ImportEvent } from "../../shared/ai-import/bundle.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { claudeCodeReader } from "./claude-code.ts";
import { collect, context, copyFixture, localSource } from "./local-fixtures.ts";

let scratch: string;
let home: string;
let staging: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "seira-ai-import-claude-code-"));
  home = copyFixture("claude-code", join(scratch, "home"));
  staging = join(scratch, "staging");
  mkdirSync(staging);
});
afterEach(() => removeTempDir(scratch));

const agentOf = (events: ImportEvent[]): ImportAgent => {
  const event = events.find((item) => item.type === "agent");
  if (event?.type !== "agent") throw new Error("no agent");
  return event.agent;
};

describe("claudeCodeReader", () => {
  it("claude code memory: offers CLAUDE.md as persona, rules as topics and project memory as memory", async () => {
    const events = await collect(claudeCodeReader, localSource("claude-code", home, undefined, "Claude Code"), context(staging));
    const agent = agentOf(events);
    expect(agent.persona).toBe("Reply briefly. Prefer TypeScript.");
    expect(agent.topics).toEqual([{ ref: "rules/style.md", title: "style", text: "Use two-space indents." }]);
    expect(agent.memories).toEqual([
      { ref: "projects/-work-app/memory/MEMORY.md#1", text: "Remember to run tests before a release" },
      { ref: "projects/-work-app/memory/user_role.md", text: "The user is a product designer." },
    ]);
    expect(agent.skills).toEqual([]);
    expect(agent.tools).toEqual([]);
  });

  it("claude code memory: puts CLAUDE.md under About you when asked", async () => {
    const agent = agentOf(await collect(claudeCodeReader, localSource("claude-code", home, undefined, "Claude Code"), context(staging, false, "about-you")));
    expect(agent.persona).toBeUndefined();
    expect(agent.aboutYou).toEqual([{ ref: "CLAUDE.md#0", text: "Reply briefly. Prefer TypeScript." }]);
    expect(agent.memories).toEqual([
      { ref: "projects/-work-app/memory/MEMORY.md#1", text: "Remember to run tests before a release" },
      { ref: "projects/-work-app/memory/user_role.md", text: "The user is a product designer." },
    ]);
  });

  it("transcripts off: reads no session by default", async () => {
    const events = await collect(claudeCodeReader, localSource("claude-code", home), context(staging));
    expect(events.filter((event) => event.type === "conversation")).toEqual([]);
  });

  it("reads transcripts as a tree when asked, without tool results", async () => {
    const events = await collect(claudeCodeReader, localSource("claude-code", home), context(staging, true));
    const chats = events.flatMap((event) => (event.type === "conversation" ? [event.conversation] : []));
    expect(chats).toHaveLength(1);
    expect(chats[0]?.ref).toBe("-work-app/s1");
    expect(chats[0]?.messages.map((message) => [message.ref, message.role, message.text, message.parentRef])).toEqual([
      ["u1", "user", "Fix the login bug", null],
      ["a1", "assistant", "Looking now.", "u1"],
      ["a2", "assistant", "Fixed.", "a1"],
    ]);
    expect(chats[0]?.messages[1]?.notes).toEqual([{ kind: "tool-call", name: "Read" }]);
    expect(chats[0]?.activeLeafRef).toBe("a2");
  });

  it("handles a home with no files", async () => {
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    const agent = agentOf(await collect(claudeCodeReader, localSource("claude-code", empty), context(staging, true)));
    expect(agent.persona).toBeUndefined();
    expect(agent.memories).toEqual([]);
  });
});
