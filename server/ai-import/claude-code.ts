import { join } from "node:path";

import { emptyAgent, type ImportAgent, type ImportConversation, type ImportEvent } from "../../shared/ai-import/bundle.ts";
import { markdownEntries } from "./local-agent.ts";
import { decodeMessageBody, jsonlConversation, type JsonlEntry } from "./local-chats.ts";
import { fileLabel, isRecord, listDirectories, listNames, readText, sourceId, toMillis } from "./local-fs.ts";
import type { ImportInput, ReaderContext, SourceReader } from "./reader.ts";

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function decodeTranscriptLine(line: Record<string, unknown>): JsonlEntry | null {
  if (typeof line.uuid !== "string") return null;
  const parentId = typeof line.parentUuid === "string" ? line.parentUuid : null;
  const body = isRecord(line.message) ? line.message : null;
  const role = body?.role;
  if (line.isSidechain === true || !body || (line.type !== "user" && line.type !== "assistant") || (role !== "user" && role !== "assistant")) return { id: line.uuid, parentId, message: null };
  const { text, notes } = decodeMessageBody(body.content);
  if (!text && notes.length === 0) return { id: line.uuid, parentId, message: null };
  return { id: line.uuid, parentId, message: { role, text, at: toMillis(line.timestamp), notes } };
}

async function* readClaudeCode(input: ImportInput, ctx: ReaderContext): AsyncGenerator<ImportEvent> {
  if (input.from !== "local") throw new Error("The Claude Code reader needs a local folder");
  const home = input.source.path;
  yield { type: "source", source: { kind: "claude-code", fingerprint: sourceId("claude-code", home) } };

  const ref = "claude-code";
  const agent: ImportAgent = emptyAgent(ref, input.source.name);
  const instructions = await readText(join(home, "CLAUDE.md"));
  if (instructions?.trim()) agent.persona = instructions.trim();

  for (const name of await listNames(join(home, "rules"))) {
    if (!name.endsWith(".md")) continue;
    const text = await readText(join(home, "rules", name));
    if (text?.trim()) agent.topics.push({ ref: `rules/${name}`, title: fileLabel(name), text: text.trim() });
  }

  const projects = await listDirectories(join(home, "projects"));
  for (const project of projects) {
    const dir = join(home, "projects", project, "memory");
    const names = (await listNames(dir)).filter((name) => name.endsWith(".md"));
    const topics = new Set(names.filter((name) => name !== "MEMORY.md"));
    const index = (await readText(join(dir, "MEMORY.md"))) ?? "";
    markdownEntries(index).forEach((entry, position) => {
      const target = /\]\(([^)]+\.md)\)/.exec(entry)?.[1];
      if (target && topics.has(target)) return;
      agent.memories.push({ ref: `projects/${project}/memory/MEMORY.md#${position}`, text: entry });
    });
    for (const name of topics) {
      const body = stripFrontmatter((await readText(join(dir, name))) ?? "");
      if (body) agent.memories.push({ ref: `projects/${project}/memory/${name}`, text: body });
    }
  }

  yield { type: "agent", agent };
  if (!ctx.transcripts) return;

  let done = 0;
  for (const project of projects) {
    for (const name of await listNames(join(home, "projects", project))) {
      if (!name.endsWith(".jsonl") || ctx.signal.aborted) continue;
      const id = `${project}/${name.slice(0, -".jsonl".length)}`;
      let conversation: ImportConversation | null;
      try {
        conversation = await jsonlConversation(join(home, "projects", project, name), id, ctx.signal, decodeTranscriptLine);
      } catch {
        yield { type: "leftover", leftover: { ref: id, kind: "conversation", name, reason: "unreadable" } };
        continue;
      }
      if (!conversation) continue;
      yield { type: "conversation", agentRef: ref, conversation };
      yield { type: "progress", done: ++done, total: null, unit: "items" };
    }
  }
}

export const claudeCodeReader: SourceReader = {
  kind: "claude-code",
  sniff: async () => false,
  read: readClaudeCode,
};
