import {
  emptyAgent,
  type ImportAttachment,
  type ImportConversation,
  type ImportEvent,
  type ImportMessage,
  type ImportNote,
} from "../../shared/ai-import/bundle.ts";
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
  peekHead,
  toMillis,
  type JsonRecord,
} from "./export-common.ts";
import { streamJsonArray, type JsonStreamItem } from "./json-stream.ts";
import type { ImportEntry, ImportFiles, ImportInput, ReaderContext, SourceReader } from "./reader.ts";

const AGENT_REF = "chatgpt";
const MAPPING_KEY = /"(?:mapping|current_node)"\s*:/;
const CLAUDE_KEY = /"chat_messages"\s*:/;
const SIBLINGS = ["chat.html", "user.json", "export_manifest.json", "message_feedback.json", "shared_conversations.json"];
const HIDDEN_CONTENT_TYPES = new Set(["thoughts", "reasoning_recap"]);
const ASSET_ID = /^(file[-_][A-Za-z0-9]+)(?:[-.]|$)/;
const POINTER_SCHEME = /^[a-z][a-z0-9-]*:\/\//;

interface Instructions {
  aboutYou: string | null;
  howToReply: string | null;
}

interface Converted {
  conversation: ImportConversation;
  instructions: Instructions;
}

type AssetIndex = ReadonlyMap<string, ImportEntry>;

function buildAssetIndex(entries: readonly ImportEntry[]): AssetIndex {
  const index = new Map<string, ImportEntry>();
  for (const entry of entries) {
    const match = ASSET_ID.exec(baseName(entry.name));
    if (match && !index.has(match[1])) index.set(match[1], entry);
  }
  return index;
}

function assetAttachment(id: string, assets: AssetIndex, fallbackName: string | null, mime: string | null, size: number | null): ImportAttachment {
  const entry = assets.get(id);
  const attachment: ImportAttachment = { ref: id, name: fallbackName ?? id };
  if (mime) attachment.mime = mime;
  if (entry) {
    const base = baseName(entry.name);
    attachment.entry = entry.name;
    attachment.size = size ?? entry.size;
    if (!fallbackName) attachment.name = base.length > id.length + 1 ? base.slice(id.length + 1) : base;
  } else {
    attachment.missing = true;
    if (size !== null) attachment.size = size;
  }
  return attachment;
}

function messageContent(message: JsonRecord, assets: AssetIndex): { text: string; attachments: ImportAttachment[] } {
  const content = asRecord(message.content);
  const texts: string[] = [];
  const attachments: ImportAttachment[] = [];
  const seen = new Set<string>();
  const add = (attachment: ImportAttachment): void => {
    if (seen.has(attachment.ref)) return;
    seen.add(attachment.ref);
    attachments.push(attachment);
  };

  if (content) {
    const parts = content.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        const record = asRecord(part);
        if (!record) continue;
        const pointer = asString(record.asset_pointer);
        if (pointer) {
          const match = ASSET_ID.exec(pointer.replace(POINTER_SCHEME, ""));
          if (match) add(assetAttachment(match[1], assets, null, null, asNumber(record.size_bytes)));
        } else {
          const inline = asString(record.text);
          if (inline) texts.push(inline);
        }
      }
    } else {
      const inline = asString(content.text);
      if (inline) texts.push(inline);
    }
  }

  const metadata = asRecord(message.metadata);
  for (const item of asArray(metadata?.attachments)) {
    const record = asRecord(item);
    const id = asString(record?.id);
    if (!record || !id) continue;
    add(assetAttachment(id, assets, asString(record.name), asString(record.mime_type) ?? asString(record.mimeType), asNumber(record.size)));
  }

  return { text: texts.filter((text) => text.trim() !== "").join("\n"), attachments };
}

function convertMessage(key: string, raw: JsonRecord, assets: AssetIndex): Omit<ImportMessage, "parentRef"> | null {
  const role = asString(asRecord(raw.author)?.role);
  if (role !== "user" && role !== "assistant") return null;
  if (raw.weight === 0) return null;
  const metadata = asRecord(raw.metadata);
  if (metadata?.is_visually_hidden_from_conversation === true) return null;
  const contentType = asString(asRecord(raw.content)?.content_type);
  if (contentType && HIDDEN_CONTENT_TYPES.has(contentType)) return null;
  const recipient = asString(raw.recipient);
  if (role === "assistant" && recipient && recipient !== "all") return null;

  const { text, attachments } = messageContent(raw, assets);
  if (text.trim() === "" && attachments.length === 0) return null;

  const message: Omit<ImportMessage, "parentRef"> = { ref: key, role, text, at: toMillis(asNumber(raw.create_time)) };
  if (attachments.length > 0) {
    message.attachments = attachments;
    const notes: ImportNote[] = attachments.filter((item) => item.missing).map((item) => ({ kind: "file-not-in-export", name: item.name }));
    if (notes.length > 0) message.notes = notes;
  }
  return message;
}

function readInstructions(message: JsonRecord): Instructions {
  const metadata = asRecord(message.metadata);
  const context = asRecord(metadata?.user_context_message_data);
  const content = asRecord(message.content);
  const pick = (...values: unknown[]): string | null => {
    for (const value of values) {
      const text = asString(value)?.trim();
      if (text) return text;
    }
    return null;
  };
  return {
    aboutYou: pick(context?.about_user_message, metadata?.about_user_message, content?.user_profile),
    howToReply: pick(context?.about_model_message, metadata?.about_model_message, content?.user_instructions),
  };
}

export function convertChatgptConversation(raw: unknown, assets: AssetIndex, position: number): Converted {
  const record = asRecord(raw);
  const mapping = asRecord(record?.mapping);
  if (!record || !mapping) throw new Error("The conversation has no message tree");

  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  const kept = new Map<string, Omit<ImportMessage, "parentRef">>();
  const instructions: Instructions = { aboutYou: null, howToReply: null };

  for (const [key, value] of Object.entries(mapping)) {
    const node = asRecord(value);
    if (!node) continue;
    const parent = asString(node.parent);
    parentOf.set(key, parent && parent in mapping ? parent : null);
    const message = asRecord(node.message);
    if (!message) continue;
    const found = readInstructions(message);
    instructions.aboutYou ??= found.aboutYou;
    instructions.howToReply ??= found.howToReply;
    const converted = convertMessage(key, message, assets);
    if (converted) kept.set(key, converted);
  }
  for (const [key, parent] of parentOf) {
    if (parent === null) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(key);
    else childrenOf.set(parent, [key]);
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

  const roots = [...parentOf].filter(([, parent]) => parent === null).map(([key]) => key);
  const current = asString(record.current_node);
  let leaf: string | null = null;
  if (current && parentOf.has(current)) {
    leaf = current;
  } else {
    let at = roots[0] ?? null;
    const visited = new Set<string>();
    while (at !== null && !visited.has(at)) {
      visited.add(at);
      const next: string | undefined = childrenOf.get(at)?.at(-1);
      if (next === undefined) break;
      at = next;
    }
    leaf = at;
  }
  const activeLeaf = nearestKept(leaf);

  const chain: string[] = [];
  const onChain = new Set<string>();
  for (let at = activeLeaf; at !== null && !onChain.has(at); at = nearestKept(parentOf.get(at) ?? null)) {
    onChain.add(at);
    chain.push(at);
  }
  chain.reverse();

  const preorder: string[] = [];
  const visited = new Set<string>();
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    preorder.push(key);
    const children = childrenOf.get(key);
    if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  const messages: ImportMessage[] = [];
  const push = (key: string): void => {
    const message = kept.get(key) as Omit<ImportMessage, "parentRef">;
    messages.push({ ...message, parentRef: nearestKept(parentOf.get(key) ?? null) });
  };
  for (const key of chain) push(key);
  for (const key of preorder) if (kept.has(key) && !onChain.has(key)) push(key);

  const id = asString(record.conversation_id) ?? asString(record.id);
  return {
    conversation: {
      ref: id ?? `conversation-${position + 1}`,
      title: asString(record.title)?.trim() || "New chat",
      createdAt: toMillis(asNumber(record.create_time)),
      updatedAt: toMillis(asNumber(record.update_time)),
      activeLeafRef: activeLeaf,
      messages,
    },
    instructions,
  };
}

interface Located {
  index: number;
  item: JsonStreamItem;
}

async function* conversationItems(
  files: ImportFiles,
  names: readonly ImportEntry[],
  progress: ByteProgress,
  ctx: ReaderContext,
): AsyncGenerator<Located> {
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

async function missingManifestFiles(files: ImportFiles): Promise<string[]> {
  const manifest = files.entries.find((entry) => baseName(entry.name) === "export_manifest.json");
  if (!manifest || manifest.size > 4 * 1024 * 1024) return [];
  try {
    const stream = await files.open(manifest.name);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const listed = asArray(asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")))?.export_files);
    const present = new Set(files.entries.map((entry) => baseName(entry.name)));
    const missing: string[] = [];
    for (const item of listed) {
      const path = asString(asRecord(item)?.path);
      if (path && /^conversations(?:-\d+)?\.json$/.test(baseName(path)) && !present.has(baseName(path))) missing.push(path);
    }
    return missing;
  } catch {
    return [];
  }
}

function toEvents(located: Located, assets: AssetIndex): { events: ImportEvent[]; instructions: Instructions | null; id: string | null } {
  const { item, index } = located;
  if (!item.ok) {
    return { events: [{ type: "leftover", leftover: { ref: leftoverRef(index), kind: "conversation", reason: item.reason } }], instructions: null, id: null };
  }
  try {
    const converted = convertChatgptConversation(item.value, assets, index);
    return {
      events: [{ type: "conversation", agentRef: AGENT_REF, conversation: converted.conversation }],
      instructions: converted.instructions,
      id: converted.conversation.ref,
    };
  } catch {
    const title = asString(asRecord(item.value)?.title);
    const leftover = { ref: leftoverRef(index), kind: "conversation" as const, reason: "unreadable" as const, ...(title ? { name: title } : {}) };
    return { events: [{ type: "leftover", leftover }], instructions: null, id: null };
  }
}

async function* read(input: ImportInput, ctx: ReaderContext): AsyncGenerator<ImportEvent> {
  if (input.from !== "files") throw new Error("The ChatGPT reader reads an export");
  const files = input.files;
  const names = conversationFiles(files.entries);
  const total = names.reduce((sum, entry) => sum + entry.size, 0);
  const assets = buildAssetIndex(files.entries);
  const progress = new ByteProgress(total);
  const items = conversationItems(files, names, progress, ctx);

  try {
    const first = await items.next();
    const firstEvents = first.done ? null : toEvents(first.value, assets);
    const instructions = firstEvents?.instructions ?? null;

    yield {
      type: "source",
      source: {
        kind: "chatgpt",
        fingerprint: fingerprintOf("chatgpt", firstEvents?.id ?? entriesSeed(files.entries)),
      },
    };
    for (const path of await missingManifestFiles(files)) {
      yield { type: "leftover", leftover: { ref: path, kind: "file", name: path, reason: "not-in-export" } };
    }

    const agent = emptyAgent(AGENT_REF, "ChatGPT");
    if (instructions?.aboutYou) agent.aboutYou.push({ ref: "about-you", text: instructions.aboutYou });
    if (instructions?.howToReply) agent.howToReply.push({ ref: "how-to-reply", text: instructions.howToReply });
    yield { type: "agent", agent };

    if (firstEvents) {
      yield* firstEvents.events;
      const step = progress.next();
      if (step) yield { type: "progress", ...step, unit: "bytes" };
      for await (const located of items) {
        yield* toEvents(located, assets).events;
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
  if (!first) return false;
  const head = await peekHead(files, first.name);
  if (CLAUDE_KEY.test(head)) return false;
  if (MAPPING_KEY.test(head)) return true;
  if (!/^\s*\[\s*\]\s*$/.test(head)) return false;
  return SIBLINGS.some((name) => hasEntry(files.entries, name));
}

export const chatgptReader: SourceReader = { kind: "chatgpt", sniff, read };
