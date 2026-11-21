import {
  emptyAgent,
  type ImportAgent,
  type ImportAttachment,
  type ImportConversation,
  type ImportEvent,
  type ImportMemoryItem,
  type ImportMessage,
  type ImportNote,
} from "../../shared/ai-import/bundle.ts";
import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import {
  ByteProgress,
  asArray,
  asNumber,
  asRecord,
  asString,
  baseName,
  conversationFiles,
  entriesSeed,
  fingerprintOf,
  hasEntry,
  leftoverRef,
  parseTime,
  peekHead,
  type JsonRecord,
} from "./export-common.ts";
import { streamJsonArray, type JsonStreamItem } from "./json-stream.ts";
import type { ImportEntry, ImportFiles, ImportInput, ReaderContext, SourceReader } from "./reader.ts";

const DEFAULT_AGENT_REF = "claude";
const CHAT_KEY = /"chat_messages"\s*:/;
const CHATGPT_KEY = /"(?:mapping|current_node)"\s*:/;

interface Memories {
  general: ImportMemoryItem[];
  byProject: Map<string, ImportMemoryItem[]>;
}

function mergeText(plain: string, blocks: string): string {
  const a = plain.trim();
  const b = blocks.trim();
  if (!b) return a;
  if (!a) return b;
  if (b.includes(a)) return b;
  if (a.includes(b)) return a;
  return `${b}\n\n${a}`;
}

function findFile(entries: readonly ImportEntry[], id: string): ImportEntry | undefined {
  return entries.find((entry) => baseName(entry.name).includes(id));
}

function convertMessage(raw: JsonRecord, entries: readonly ImportEntry[]): Omit<ImportMessage, "parentRef"> | null {
  const uuid = asString(raw.uuid);
  const sender = asString(raw.sender);
  if (!uuid || (sender !== "human" && sender !== "assistant")) return null;

  const blockTexts: string[] = [];
  const notes: ImportNote[] = [];
  for (const block of asArray(raw.content)) {
    const record = asRecord(block);
    const type = asString(record?.type);
    if (type === "text") {
      const text = asString(record?.text);
      if (text) blockTexts.push(text);
    } else if (type === "tool_use") {
      notes.push({ kind: "tool-call", name: asString(record?.name) ?? "tool" });
    }
  }
  const sections = [mergeText(asString(raw.text) ?? "", blockTexts.join("\n\n"))];

  const attachments: ImportAttachment[] = [];
  asArray(raw.attachments).forEach((item, position) => {
    const record = asRecord(item);
    if (!record) return;
    const name = asString(record.file_name) ?? `attachment-${position + 1}`;
    const attachment: ImportAttachment = { ref: `${uuid}:attachment-${position + 1}`, name };
    const mime = asString(record.file_type);
    const size = asNumber(record.file_size);
    if (mime) attachment.mime = mime;
    if (size !== null) attachment.size = size;
    const content = asString(record.extracted_content);
    if (content && content.trim() !== "") {
      sections.push(`[${name}]\n${content}`);
    } else {
      attachment.missing = true;
      notes.push({ kind: "file-not-in-export", name });
    }
    attachments.push(attachment);
  });
  for (const item of asArray(raw.files)) {
    const record = asRecord(item);
    const id = asString(record?.file_uuid);
    if (!record || !id) continue;
    const name = asString(record.file_name) ?? id;
    const attachment: ImportAttachment = { ref: id, name };
    const entry = findFile(entries, id);
    if (entry) {
      attachment.entry = entry.name;
      attachment.size = entry.size;
    } else {
      attachment.missing = true;
      notes.push({ kind: "file-not-in-export", name });
    }
    attachments.push(attachment);
  }

  const text = sections.filter((section) => section !== "").join("\n\n");
  if (text === "" && attachments.length === 0 && notes.length === 0) return null;

  const message: Omit<ImportMessage, "parentRef"> = {
    ref: uuid,
    role: sender === "human" ? "user" : "assistant",
    text,
    at: parseTime(raw.created_at),
  };
  if (attachments.length > 0) message.attachments = attachments;
  if (notes.length > 0) message.notes = notes;
  return message;
}

export function convertClaudeConversation(raw: unknown, entries: readonly ImportEntry[], position: number): { conversation: ImportConversation; projectRef: string | null } {
  const record = asRecord(raw);
  const list = asArray(record?.chat_messages);
  if (!record || !Array.isArray(record.chat_messages)) throw new Error("The conversation has no messages");

  const order: string[] = [];
  const parentOf = new Map<string, string | null>();
  const kept = new Map<string, Omit<ImportMessage, "parentRef">>();
  const known = new Set<string>();
  for (const item of list) {
    const uuid = asString(asRecord(item)?.uuid);
    if (uuid) known.add(uuid);
  }
  const hasParents = list.some((item) => typeof asRecord(item)?.parent_message_uuid === "string");

  let previous: string | null = null;
  for (const item of list) {
    const message = asRecord(item);
    const uuid = asString(message?.uuid);
    if (!message || !uuid) continue;
    order.push(uuid);
    const declared = asString(message.parent_message_uuid);
    parentOf.set(uuid, hasParents ? (declared && known.has(declared) && declared !== uuid ? declared : null) : previous);
    previous = uuid;
    const converted = convertMessage(message, entries);
    if (converted) kept.set(uuid, converted);
  }

  const nearestKept = (start: string | null): string | null => {
    const visited = new Set<string>();
    let at = start;
    while (at !== null && !visited.has(at)) {
      if (kept.has(at)) return at;
      visited.add(at);
      at = parentOf.get(at) ?? null;
    }
    return null;
  };

  const declaredLeaf = asString(record.current_leaf_message_uuid);
  const leaf = declaredLeaf && parentOf.has(declaredLeaf) ? declaredLeaf : (order.at(-1) ?? null);
  const messages: ImportMessage[] = order
    .filter((uuid) => kept.has(uuid))
    .map((uuid) => ({ ...(kept.get(uuid) as Omit<ImportMessage, "parentRef">), parentRef: nearestKept(parentOf.get(uuid) ?? null) }));

  const project = asString(record.project_uuid) ?? asString(asRecord(record.project)?.uuid);
  return {
    conversation: {
      ref: asString(record.uuid) ?? `conversation-${position + 1}`,
      title: asString(record.name)?.trim() || "Untitled",
      createdAt: parseTime(record.created_at),
      updatedAt: parseTime(record.updated_at),
      activeLeafRef: nearestKept(leaf),
      messages,
    },
    projectRef: project,
  };
}

function convertProject(raw: unknown): { uuid: string; agent: ImportAgent } {
  const record = asRecord(raw);
  const uuid = asString(record?.uuid);
  if (!record || !uuid) throw new Error("The project has no ID");
  const agent = emptyAgent(`project-${uuid}`, asString(record.name)?.trim() || "Project");
  const persona = asString(record.prompt_template)?.trim();
  if (persona) agent.persona = persona;
  for (const doc of asArray(record.docs)) {
    const item = asRecord(doc);
    const content = asString(item?.content);
    if (!item || content === null || content.trim() === "") continue;
    const filename = asString(item.filename) ?? "Document";
    agent.topics.push({ ref: asString(item.uuid) ?? `${uuid}/${filename}`, title: filename, text: content });
  }
  return { uuid, agent };
}

function parseMemories(value: unknown): Memories {
  const memories: Memories = { general: [], byProject: new Map() };
  const addGeneral = (text: string): void => {
    memories.general.push({ ref: `memory-${memories.general.length + 1}`, text });
  };
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim()) addGeneral(item.trim());
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const general = asString(record.conversations_memory)?.trim();
    if (general) addGeneral(general);
    else {
      const plain = (asString(record.text) ?? asString(record.memory) ?? asString(record.content))?.trim();
      if (plain) addGeneral(plain);
    }
    for (const [project, text] of Object.entries(asRecord(record.project_memories) ?? {})) {
      const body = asString(text)?.trim();
      if (!body) continue;
      const list = memories.byProject.get(project) ?? [];
      list.push({ ref: `memory-${project}-${list.length + 1}`, text: body });
      memories.byProject.set(project, list);
    }
  }
  return memories;
}

async function readSmallJson(files: ImportFiles, entry: ImportEntry): Promise<{ value: unknown } | { reason: "too-large" | "unreadable" }> {
  if (entry.size > AI_IMPORT_LIMITS.otherMemberBytes) return { reason: "too-large" };
  const stream = await files.open(entry.name);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { reason: "unreadable" };
  }
}

interface Located {
  index: number;
  item: JsonStreamItem;
}

async function* conversationItems(files: ImportFiles, names: readonly ImportEntry[], progress: ByteProgress, ctx: ReaderContext): AsyncGenerator<Located> {
  let index = 0;
  for (const entry of names) {
    const stream = await files.open(entry.name);
    try {
      for await (const item of streamJsonArray(progress.count(stream))) {
        ctx.signal.throwIfAborted();
        yield { index: index++, item };
      }
    } finally {
      stream.destroy();
    }
  }
}

async function* read(input: ImportInput, ctx: ReaderContext): AsyncGenerator<ImportEvent> {
  if (input.from !== "files") throw new Error("The Claude reader reads an export");
  const files = input.files;
  const entries = files.entries;
  const names = conversationFiles(entries);
  const projectsEntry = entries.find((entry) => baseName(entry.name) === "projects.json");
  const memoriesEntry = entries.find((entry) => baseName(entry.name) === "memories.json");
  const total = names.reduce((sum, entry) => sum + entry.size, 0) + (projectsEntry?.size ?? 0);
  const progress = new ByteProgress(total);
  const items = conversationItems(files, names, progress, ctx);

  const toEvent = (located: Located): { events: ImportEvent[]; id: string | null; projectRef: string | null; conversation: ImportConversation | null } => {
    const { item, index } = located;
    if (!item.ok) {
      return { events: [{ type: "leftover", leftover: { ref: leftoverRef(index), kind: "conversation", reason: item.reason } }], id: null, projectRef: null, conversation: null };
    }
    try {
      const converted = convertClaudeConversation(item.value, entries, index);
      return { events: [], id: converted.conversation.ref, projectRef: converted.projectRef, conversation: converted.conversation };
    } catch {
      const title = asString(asRecord(item.value)?.name);
      const leftover = { ref: leftoverRef(index), kind: "conversation" as const, reason: "unreadable" as const, ...(title ? { name: title } : {}) };
      return { events: [{ type: "leftover", leftover }], id: null, projectRef: null, conversation: null };
    }
  };

  try {
    const first = await items.next();
    const firstResult = first.done ? null : toEvent(first.value);

    yield { type: "source", source: { kind: "claude-ai", fingerprint: fingerprintOf("claude-ai", firstResult?.id ?? entriesSeed(entries)) } };

    let memories: Memories = { general: [], byProject: new Map() };
    if (memoriesEntry) {
      const result = await readSmallJson(files, memoriesEntry);
      if ("value" in result) memories = parseMemories(result.value);
      else yield { type: "leftover", leftover: { ref: memoriesEntry.name, kind: "memory", name: memoriesEntry.name, reason: result.reason } };
    }

    const projectRefs = new Map<string, string>();
    if (projectsEntry) {
      const stream = await files.open(projectsEntry.name);
      try {
        for await (const item of streamJsonArray(progress.count(stream))) {
          ctx.signal.throwIfAborted();
          if (!item.ok) {
            yield { type: "leftover", leftover: { ref: `project-${item.index + 1}`, kind: "topic", reason: item.reason } };
            continue;
          }
          try {
            const { uuid, agent } = convertProject(item.value);
            agent.memories.push(...(memories.byProject.get(uuid) ?? []));
            projectRefs.set(uuid, agent.ref);
            yield { type: "agent", agent };
          } catch {
            const name = asString(asRecord(item.value)?.name);
            yield { type: "leftover", leftover: { ref: `project-${item.index + 1}`, kind: "topic", reason: "unreadable", ...(name ? { name } : {}) } };
          }
        }
      } finally {
        stream.destroy();
      }
    }

    let defaultEmitted = false;
    const defaultAgent = (): ImportEvent => {
      defaultEmitted = true;
      const agent = emptyAgent(DEFAULT_AGENT_REF, "Claude");
      agent.memories.push(...memories.general);
      return { type: "agent", agent };
    };
    if (memories.general.length > 0) yield defaultAgent();

    const handle = function* (result: ReturnType<typeof toEvent>): Generator<ImportEvent> {
      yield* result.events;
      if (!result.conversation) return;
      const known = result.projectRef ? projectRefs.get(result.projectRef) : undefined;
      if (!known && !defaultEmitted) yield defaultAgent();
      yield { type: "conversation", agentRef: known ?? DEFAULT_AGENT_REF, conversation: result.conversation };
    };

    if (firstResult) {
      yield* handle(firstResult);
      const step = progress.next();
      if (step) yield { type: "progress", ...step, unit: "bytes" };
      for await (const located of items) {
        yield* handle(toEvent(located));
        const next = progress.next();
        if (next) yield { type: "progress", ...next, unit: "bytes" };
      }
    }
    yield { type: "progress", ...progress.last(), unit: "bytes" };
  } finally {
    await items.return(undefined);
  }
}

async function sniff(files: ImportFiles): Promise<boolean> {
  const [first] = conversationFiles(files.entries);
  if (first) {
    const head = await peekHead(files, first.name);
    if (CHAT_KEY.test(head)) return true;
    if (CHATGPT_KEY.test(head)) return false;
  }
  return hasEntry(files.entries, "projects.json") && hasEntry(files.entries, "users.json");
}

export const claudeAiReader: SourceReader = { kind: "claude-ai", sniff, read };
