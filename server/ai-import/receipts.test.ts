import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import { listSkills, setSkillEnabled } from "../skills.ts";
import { applyFastLane } from "./apply.ts";
import { sha256, stableId } from "./ids.ts";
import { expireReceipts, undoJob } from "./receipts.ts";
import {
  conversation, createApplyEnv, DAY, fullAgent, jobView, NOW, runImport, SOURCE, spool, type ApplyEnv,
} from "./testing/apply-fixtures.ts";

let env: ApplyEnv;
beforeEach(() => {
  env = createApplyEnv();
});
afterEach(() => env.dispose());

const TOPIC = "Garden notes.md";
const threadOf = (jobId: string, ref: string) => stableId(jobId, `a1/chat/${ref}`);
const importedThreads = (botId: string) => (env.store.bot(botId)?.tasks ?? []).filter((task) => task.imported);
const stored = (botId: string, ref: string, jobId = "job-1") => env.ports.threads.state(botId, threadOf(jobId, ref));

describe("receipts", () => {
  it("fingerprint per item", async () => {
    const run = await runImport(env, { agents: [fullAgent(env)], chats: spool("a1", [conversation("c1", "Chat one", 4)]) });

    const receipts = env.db.receipts("job-1").filter((receipt) => receipt.kind !== "bot");
    expect(new Set(receipts.map((receipt) => receipt.kind))).toEqual(new Set(["persona", "memory", "topic", "skill", "tool", "routine", "conversation"]));
    for (const receipt of receipts) {
      const fingerprint = env.db.fingerprint({ sourceKind: SOURCE.kind, sourceFp: SOURCE.fingerprint, itemKey: receipt.itemKey });
      expect(fingerprint, receipt.itemKey).not.toBeNull();
      expect(fingerprint!.sourceKind).toBe("chatgpt");
      expect(fingerprint!.sourceFp).toBe(SOURCE.fingerprint);
      expect(fingerprint!.itemKey).toBe(receipt.itemKey);
      expect(fingerprint!.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(fingerprint!.jobId).toBe("job-1");
      expect(fingerprint!.target.botId).toBe(run.botId);
    }
    const memory = env.db.fingerprint({ sourceKind: SOURCE.kind, sourceFp: SOURCE.fingerprint, itemKey: "a1/memory/mem-1" });
    expect(memory?.contentHash).toBe(sha256("Prefers metric units (v1)."));
    const other = env.db.fingerprint({ sourceKind: "claude-ai", sourceFp: SOURCE.fingerprint, itemKey: "a1/memory/mem-1" });
    expect(other).toBeNull();
  });

  it("re-import updates", async () => {
    const first = await runImport(env, { agents: [fullAgent(env)], chats: spool("a1", [conversation("c1", "Chat one", 4)]) });
    const shape = () => ({
      threads: importedThreads(first.botId).length,
      memory: env.ports.memory.read(first.botId).split("\n").filter((line) => line.trim()).length,
      skills: listSkills(first.botId).length,
      routines: env.routines.size,
      tools: Object.keys(env.mcpServers).length,
      bots: env.store.bots.length,
    });
    const before = shape();

    const second = await runImport(env, {
      jobId: "job-2",
      agents: [fullAgent(env, { version: 2 })],
      chats: spool("a1", [conversation("c1", "Chat one", 6)]),
      destinations: { a1: { kind: "bot", botId: first.botId } },
    });

    expect(second.botId).toBe(first.botId);
    expect(second.report.added).toBe(0);
    expect(second.report.keptBoth).toBe(0);
    expect(second.report.updated).toBeGreaterThanOrEqual(9);
    expect(shape()).toEqual(before);
    expect(env.ports.bots.soul(first.botId)).toContain("(v2)");
    expect(env.ports.bots.soul(first.botId)).not.toContain("(v1)");
    expect(env.ports.memory.read(first.botId)).toContain("Prefers metric units (v2).");
    expect(env.ports.memory.read(first.botId)).not.toContain("(v1)");
    expect(env.ports.memory.readTopic(first.botId, TOPIC)).toContain("(v2)");
    expect(env.ports.memory.readTopic(first.botId, "Garden notes 2.md")).toBeNull();
    expect([...env.routines.values()].map((routine) => routine.prompt)).toEqual(expect.arrayContaining(["Summarize the news (v2)."]));
    expect(stored(first.botId, "c1")?.messages).toBe(6);
    expect(stored(first.botId, "c1", "job-2")).toBeNull();
  });

  it("re-import keeps both", async () => {
    const first = await runImport(env, { agents: [fullAgent(env)], chats: spool("a1", [conversation("c1", "Chat one", 4)]) });
    const botId = first.botId;
    const mine = "My own notes on tomatoes.";
    env.ports.memory.writeTopic(botId, TOPIC, mine);
    env.ports.threads.append([{
      threadId: threadOf("job-1", "c1"),
      messages: [{ id: "my-reply", parentId: stableId(threadOf("job-1", "c1"), "c1-m4"), role: "user", text: "My own follow-up.", at: NOW + 1 }],
      activeLeafId: "my-reply",
    }]);
    const soul = `${env.ports.bots.soul(botId)}\n\nMine.`;
    env.ports.bots.setSoul(botId, soul);

    const second = await runImport(env, {
      jobId: "job-2",
      agents: [fullAgent(env, { version: 2 })],
      chats: spool("a1", [conversation("c1", "Chat one", 6)]),
      destinations: { a1: { kind: "bot", botId } },
    });

    expect(env.ports.memory.readTopic(botId, TOPIC)).toBe(mine);
    expect(env.ports.memory.readTopic(botId, "Garden notes 2.md")).toContain("(v2)");
    expect(env.store.messagesFor(threadOf("job-1", "c1")).map((message) => message.text)).toContain("My own follow-up.");
    expect(stored(botId, "c1", "job-2")?.messages).toBe(6);
    expect(importedThreads(botId)).toHaveLength(2);
    expect(env.ports.bots.soul(botId)).toBe(soul);
    expect(env.ports.memory.readTopic(botId, "Persona from ChatGPT.md")).toContain("(v2)");
    expect(second.report.keptBoth).toBeGreaterThanOrEqual(3);
    expect(second.report.updated).toBeGreaterThan(0);
    expect(second.report.added).toBe(0);
  });

  it("undo", async () => {
    const first = await runImport(env, { agents: [fullAgent(env)], chats: spool("a1", [conversation("keep", "Kept chat", 4)]) });
    const botId = first.botId;
    const snapshot = {
      soul: env.ports.bots.soul(botId),
      memory: env.ports.memory.read(botId),
      topic: env.ports.memory.readTopic(botId, TOPIC),
      skill: env.ports.skills.hash(botId, "tidy-notes"),
      skillOn: env.ports.skills.enabled(botId, "tidy-notes"),
      servers: structuredClone(env.mcpServers),
      routines: [...env.routines.entries()].map(([id, routine]) => [id, routine.prompt]),
      messages: stored(botId, "keep")?.messages,
    };
    const added = Array.from({ length: 1_000 }, (_, index) => conversation(`new-${index}`, `New chat ${index}`, 2));
    await runImport(env, {
      jobId: "job-2",
      agents: [fullAgent(env, { version: 2 })],
      chats: spool("a1", [conversation("keep", "Kept chat", 6), ...added]),
      destinations: { a1: { kind: "bot", botId } },
    });
    expect(importedThreads(botId)).toHaveLength(1_001);
    expect(env.ports.memory.readTopic(botId, TOPIC)).toContain("(v2)");

    const start = performance.now();
    const result = undoJob(env.db, "job-2", env.ports);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThanOrEqual(10_000);
    expect(result.kept).toEqual([]);
    expect(result.removed).toBeGreaterThanOrEqual(1_000);
    expect(result.restored).toBeGreaterThanOrEqual(8);
    expect(importedThreads(botId)).toHaveLength(1);
    for (let index = 0; index < added.length; index++) {
      expect(stored(botId, `new-${index}`, "job-2"), `new-${index}`).toBeNull();
    }
    expect(stored(botId, "keep")?.messages).toBe(snapshot.messages);
    expect(env.ports.bots.soul(botId)).toBe(snapshot.soul);
    expect(env.ports.memory.read(botId)).toBe(snapshot.memory);
    expect(env.ports.memory.readTopic(botId, TOPIC)).toBe(snapshot.topic);
    expect(env.ports.skills.hash(botId, "tidy-notes")).toBe(snapshot.skill);
    expect(snapshot.skillOn).toBe(true);
    expect(env.ports.skills.enabled(botId, "tidy-notes")).toBe(true);
    expect(env.mcpServers).toEqual(snapshot.servers);
    expect([...env.routines.entries()].map(([id, routine]) => [id, routine.prompt])).toEqual(snapshot.routines);
    expect(env.db.receipts("job-2")).toEqual([]);
  });

  it("re-import keeps a skill off", async () => {
    const first = await runImport(env, { agents: [fullAgent(env)], chats: spool("a1", []) });
    const botId = first.botId;
    setSkillEnabled(botId, "tidy-notes", false);
    const hash = env.ports.skills.hash(botId, "tidy-notes");

    await runImport(env, { jobId: "job-2", agents: [fullAgent(env, { version: 2 })], chats: spool("a1", []), destinations: { a1: { kind: "bot", botId } } });

    expect(env.ports.skills.hash(botId, "tidy-notes")).not.toBe(hash);
    expect(env.ports.skills.enabled(botId, "tidy-notes")).toBe(false);
    undoJob(env.db, "job-2", env.ports);
    expect(env.ports.skills.hash(botId, "tidy-notes")).toBe(hash);
    expect(env.ports.skills.enabled(botId, "tidy-notes")).toBe(false);
  });

  it("undo keeps changed items", async () => {
    const first = await runImport(env, { agents: [fullAgent(env)], chats: spool("a1", [conversation("c1", "Chat one", 4)]) });
    const botId = first.botId;
    const mine = "My own notes on tomatoes.";
    env.ports.memory.writeTopic(botId, TOPIC, mine);
    env.ports.threads.append([{
      threadId: threadOf("job-1", "c1"),
      messages: [{ id: "my-reply", parentId: stableId(threadOf("job-1", "c1"), "c1-m4"), role: "user", text: "My own follow-up.", at: NOW + 1 }],
      activeLeafId: "my-reply",
    }]);

    const result = undoJob(env.db, "job-1", env.ports);

    expect(result.kept).toEqual(expect.arrayContaining(["Garden notes", "Chat one"]));
    expect(env.ports.memory.readTopic(botId, TOPIC)).toBe(mine);
    expect(stored(botId, "c1")?.messages).toBe(5);
    expect(env.ports.bots.exists(botId)).toBe(true);
    expect(result.removed).toBeGreaterThan(0);
    expect(listSkills(botId)).toEqual([]);
    expect(env.routines.size).toBe(0);
    expect(env.mcpServers).toEqual({});
    expect(env.ports.memory.readTopic(botId, "About you from ChatGPT.md")).toBeNull();
    expect(env.ports.memory.read(botId)).not.toContain("metric units");
  });

  it("receipts expire", () => {
    const ctx = env.context();
    ctx.agents = [fullAgent(env)];
    const fast = applyFastLane(ctx);
    const undoUntil = NOW + AI_IMPORT_LIMITS.undoDays * DAY;
    env.db.insertJob({
      id: "job-1",
      view: jobView("job-1", undoUntil),
      input: { from: "paste", ai: "chatgpt", aboutYou: [], howToReply: [], destination: { kind: "new" } },
      plan: null,
      cursor: null,
    });
    expect(env.db.receiptCount("job-1")).toBeGreaterThan(0);

    expect(expireReceipts(env.db, undoUntil - 1)).toEqual([]);
    expect(env.db.receiptCount("job-1")).toBeGreaterThan(0);

    const changed = expireReceipts(env.db, undoUntil + 1);

    expect(changed).toHaveLength(1);
    expect(changed[0]!.id).toBe("job-1");
    expect(changed[0]!.undoUntil).toBeNull();
    expect(env.db.receiptCount("job-1")).toBe(0);
    expect(env.db.job("job-1")?.view.undoUntil).toBeNull();
    expect(env.ports.memory.readTopic(fast.bots.a1!, TOPIC)).toContain("(v1)");
    expect(expireReceipts(env.db, undoUntil + 2)).toEqual([]);
  });
});
