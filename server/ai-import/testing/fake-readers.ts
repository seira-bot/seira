import { text } from "node:stream/consumers";

import type { ImportConversation, ImportEvent, ImportMessage } from "../../../shared/ai-import/bundle.ts";
import type { ImportInput, SourceReader } from "../reader.ts";

export const FAKE_EXPORT_NAME = "fake-export.json";

/** The JSON a test puts in the fake export. Every field is optional. */
export interface FakeScript {
  agents?: number;
  conversations?: number;
  messagesPer?: number;
  /** Wait before each conversation. */
  delayMs?: number;
  /** Throw after this many conversations. */
  throwAfter?: number;
  /** Wait this long after the first conversation. */
  hangMs?: number;
  /** Report one leftover file at the end. */
  leftover?: boolean;
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

function conversation(index: number, count: number): ImportConversation {
  const messages: ImportMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      ref: `m${i}`,
      parentRef: i === 0 ? null : `m${i - 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i} of chat ${index}`,
      at: 1_700_000_000_000 + index * 1000 + i,
    });
  }
  return {
    ref: `c${index}`,
    title: `Chat ${index}`,
    createdAt: 1_700_000_000_000 + index * 1000,
    updatedAt: 1_700_000_000_000 + index * 1000 + count,
    activeLeafRef: count ? `m${count - 1}` : null,
    messages,
  };
}

async function* read(input: ImportInput, ctx: { signal: AbortSignal }): AsyncGenerator<ImportEvent> {
  if (input.from !== "files") throw new Error("The fake reader reads uploads only");
  const stream = await input.files.open(FAKE_EXPORT_NAME);
  const script = JSON.parse(await text(stream)) as FakeScript;
  const agents = Math.max(1, script.agents ?? 1);
  const conversations = script.conversations ?? 0;
  yield { type: "source", source: { kind: "chatgpt", fingerprint: `fake:${agents}:${conversations}:${script.messagesPer ?? 0}` } };
  for (let a = 0; a < agents; a++) {
    yield {
      type: "agent",
      agent: {
        ref: `agent-${a}`, name: `Fake ${a}`, howToReply: [], aboutYou: [{ ref: `about-${a}`, text: `About ${a}` }], memories: [],
        topics: [], dailyNotes: [], skills: [], tools: [], routines: [], channels: [],
      },
    };
  }
  for (let c = 0; c < conversations; c++) {
    if (script.throwAfter !== undefined && c >= script.throwAfter) throw new Error("The fake reader failed on purpose");
    await wait(script.delayMs ?? 0, ctx.signal);
    yield { type: "conversation", agentRef: `agent-${c % agents}`, conversation: conversation(c, script.messagesPer ?? 2) };
    yield { type: "progress", done: c + 1, total: conversations, unit: "items" };
    if (c === 0) await wait(script.hangMs ?? 0, ctx.signal);
  }
  if (script.leftover) yield { type: "leftover", leftover: { ref: "left-0", kind: "file", name: "skipped.bin", reason: "unsupported" } };
}

const fakeReader: SourceReader = {
  kind: "chatgpt",
  sniff: async (files) => files.entries.some((entry) => entry.name === FAKE_EXPORT_NAME),
  read,
};

export const READERS: readonly SourceReader[] = [fakeReader];
