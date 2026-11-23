import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportConversation, ImportMessage } from "../../shared/ai-import/bundle.ts";
import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import { importedThreadStats } from "../store-imported.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { applyChats, applyFastLane, type ApplyContext } from "./apply.ts";
import { ImportDb } from "./db.ts";
import { CHATS_FILE, type SpoolLine } from "./spool.ts";
import { importHarness } from "./testing/harness.ts";

const MESSAGES = 20_000;
const CHATS = 40;
const MIN_PER_SECOND = 2_000;

let dir: string;
beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "ai-import-perf-"));
});
afterEach(() => removeTempDir(dir));

function chat(index: number, count: number): ImportConversation {
  const messages: ImportMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      ref: `m${i}`, parentRef: i === 0 ? null : `m${i - 1}`, role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i} of chat ${index}: a short line of plain text.`, at: 1_700_000_000_000 + i,
    });
  }
  return { ref: `c${index}`, title: `Chat ${index}`, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 + count, activeLeafRef: `m${count - 1}`, messages };
}

describe.skipIf(process.env.AI_IMPORT_PERF !== "1")("apply speed", () => {
  it("apply rate", async () => {
    const harness = importHarness();
    const staging = join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    const per = MESSAGES / CHATS;
    const lines: string[] = [];
    for (let c = 0; c < CHATS; c++) lines.push(JSON.stringify({ agentRef: "agent", conversation: chat(c, per) } satisfies SpoolLine));
    writeFileSync(join(staging, CHATS_FILE), `${lines.join("\n")}\n`);

    const db = new ImportDb(join(dir, "db"));
    const ctx: ApplyContext = {
      jobId: "perf-job", db, ports: harness.ports, source: { kind: "chatgpt", fingerprint: "perf" }, label: "ChatGPT",
      agents: [{ ref: "agent", name: "Perf", howToReply: [], aboutYou: [], memories: [], topics: [], dailyNotes: [], skills: [], tools: [], routines: [], channels: [] }],
      destinations: { agent: { kind: "new" } }, stagingDir: staging, now: Date.now,
    };
    db.insertJob({
      id: "perf-job", input: { from: "upload", uploadIds: [] }, plan: null, cursor: null,
      view: {
        id: "perf-job", source: { kind: "chatgpt" }, state: "applying", createdAt: 0, updatedAt: 0, progress: { done: 0, total: MESSAGES, unit: "items" },
        counts: { conversations: CHATS, messages: MESSAGES, memories: 0, topics: 0, skills: 0, tools: 0, routines: 0, channels: 0, attachments: 0, leftovers: 0 },
        agents: [], report: null, undoUntil: null, undoResult: null, error: null,
      },
    });
    const fast = applyFastLane(ctx);
    const started = performance.now();
    const result = await applyChats(ctx, fast.bots, { fast: true, conv: 0, msg: 0, done: 0 }, { stop: () => null, progress: () => undefined });
    const seconds = (performance.now() - started) / 1000;
    db.close();
    const rate = MESSAGES / seconds;
    console.info(`apply rate: ${Math.round(rate)} messages per second (${MESSAGES} messages in ${seconds.toFixed(2)} s)`);
    expect(result).toBe("done");
    const written = harness.store.bots.flatMap((bot) => bot.tasks ?? []).filter((task) => task.imported);
    expect(written).toHaveLength(CHATS);
    expect(written.reduce((sum, task) => sum + (importedThreadStats(task.threadId)?.messages ?? 0), 0)).toBe(MESSAGES);
    expect(rate).toBeGreaterThanOrEqual(MIN_PER_SECOND);
  }, 120_000);
});
