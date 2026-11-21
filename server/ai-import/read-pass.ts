import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

import type { ImportCounts, ImportErrorCode } from "../../shared/ai-import/api.ts";
import { emptyCounts } from "../../shared/ai-import/api.ts";
import { emptyAgent, type ImportAgent, type ImportLeftover, type ImportSource, type ImportSourceKind } from "../../shared/ai-import/bundle.ts";
import { hashOf } from "./ids.ts";
import { sourceLabel } from "./labels.ts";
import type { ImportFiles, ImportInput, LocalSource, SourceReader } from "./reader.ts";
import { READERS } from "./readers.ts";
import { sniffSource } from "./sniff.ts";
import { CHATS_FILE, SUMMARY_FILE, type ReadSummary, type SpoolLine } from "./spool.ts";
import { ImportUploadError, openUploads, type ImportLimits, type UploadPart } from "./upload.ts";

export interface ReadPassParams {
  input: { from: "files"; parts: UploadPart[] } | { from: "local"; source: LocalSource; transcripts: boolean };
  stagingDir: string;
  /** Tests only: a module that exports READERS in place of the real readers. Never set from a request. */
  readersModule?: string;
  limits?: ImportLimits;
  heartbeatMs?: number;
}

export interface ReadSnapshot {
  kind: ImportSourceKind | null;
  counts: ImportCounts;
  agents: Array<{ ref: string; name: string; counts: ImportCounts }>;
  progress: { done: number; total: number | null; unit: "bytes" | "items" };
}

export type ReadPassMessage =
  | { type: "sniffed"; kind: ImportSourceKind }
  | { type: "progress"; snapshot: ReadSnapshot }
  | { type: "done"; snapshot: ReadSnapshot }
  | { type: "error"; code: ImportErrorCode };


function addCounts(into: ImportCounts, add: Partial<ImportCounts>, sign = 1): void {
  for (const key of Object.keys(add) as Array<keyof ImportCounts>) into[key] += sign * (add[key] ?? 0);
}

function agentCounts(agent: ImportAgent): Partial<ImportCounts> {
  return {
    memories: agent.memories.length + agent.aboutYou.length,
    topics: agent.topics.length + agent.dailyNotes.length,
    skills: agent.skills.length,
    tools: agent.tools.length,
    routines: agent.routines.length,
    channels: agent.channels.length,
  };
}

async function loadReaders(module?: string): Promise<readonly SourceReader[]> {
  if (!module) return READERS;
  return ((await import(module)) as { READERS: readonly SourceReader[] }).READERS;
}

/** Reads one source into the spool. Runs inside the import worker; it never writes outside `stagingDir`. */
export async function runReadPass(params: ReadPassParams, post: (message: ReadPassMessage) => void, signal: AbortSignal): Promise<void> {
  const readers = await loadReaders(params.readersModule);
  let reader: SourceReader | undefined;
  let input: ImportInput;
  if (params.input.from === "files") {
    let files: ImportFiles;
    try {
      files = await openUploads(params.input.parts, params.limits);
    } catch (error) {
      post({ type: "error", code: error instanceof ImportUploadError ? error.code : "unknown-source" });
      return;
    }
    reader = (await sniffSource(files, readers)) ?? undefined;
    input = { from: "files", files };
  } else {
    const kind = params.input.source.kind;
    reader = readers.find((candidate) => candidate.kind === kind);
    input = { from: "local", source: params.input.source };
  }
  if (!reader) {
    post({ type: "error", code: "unknown-source" });
    return;
  }
  const chosen: SourceReader = reader;
  post({ type: "sniffed", kind: chosen.kind });

  const filesDir = join(params.stagingDir, "files");
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const spool = createWriteStream(join(params.stagingDir, CHATS_FILE), { mode: 0o600 });
  const counts = emptyCounts();
  const agents = new Map<string, ImportAgent>();
  const agentTotals = new Map<string, ImportCounts>();
  const leftovers: ImportLeftover[] = [];
  let source: ImportSource | null = null;
  let progress: ReadSnapshot["progress"] = { done: 0, total: null, unit: "items" };
  const totalsFor = (ref: string) => {
    if (!agentTotals.has(ref)) agentTotals.set(ref, emptyCounts());
    return agentTotals.get(ref)!;
  };
  const snapshot = (): ReadSnapshot => ({
    kind: chosen.kind,
    counts: { ...counts },
    agents: [...agentTotals].map(([ref, agentCount]) => ({ ref, name: agents.get(ref)?.name ?? ref, counts: { ...agentCount } })),
    progress: { ...progress },
  });
  const leave = (leftover: ImportLeftover, agentRef?: string) => {
    leftovers.push(leftover);
    counts.leftovers += 1;
    if (agentRef) totalsFor(agentRef).leftovers += 1;
  };
  let lastPost = 0;
  const postProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPost < 250) return;
    lastPost = now;
    post({ type: "progress", snapshot: snapshot() });
  };
  const heartbeat = setInterval(() => postProgress(true), params.heartbeatMs ?? 500);
  postProgress(true);

  try {
    const ctx = { signal, stagingDir: filesDir, transcripts: params.input.from === "local" ? params.input.transcripts : true };
    for await (const event of chosen.read(input, ctx)) {
      if (signal.aborted) return;
      switch (event.type) {
        case "source":
          source = event.source;
          break;
        case "agent": {
          const totals = totalsFor(event.agent.ref);
          const old = agents.get(event.agent.ref);
          if (old) {
            addCounts(counts, agentCounts(old), -1);
            addCounts(totals, agentCounts(old), -1);
          }
          agents.set(event.agent.ref, event.agent);
          addCounts(counts, agentCounts(event.agent));
          addCounts(totals, agentCounts(event.agent));
          break;
        }
        case "conversation": {
          const { conversation, agentRef } = event;
          let attachments = 0;
          for (const message of conversation.messages) {
            for (const attachment of message.attachments ?? []) {
              attachments += 1;
              leave({ ref: attachment.ref, kind: "attachment", name: attachment.name, reason: attachment.missing ? "not-in-export" : "unsupported" }, agentRef);
            }
          }
          const add = { conversations: 1, messages: conversation.messages.length, attachments };
          addCounts(counts, add);
          addCounts(totalsFor(agentRef), add);
          const line: SpoolLine = { agentRef, conversation };
          if (!spool.write(`${JSON.stringify(line)}\n`)) await once(spool, "drain");
          break;
        }
        case "leftover":
          leave(event.leftover);
          break;
        case "progress":
          progress = { done: event.done, total: event.total, unit: event.unit };
          break;
      }
      postProgress();
    }
    spool.end();
    await once(spool, "finish");
    if (signal.aborted) return;
    for (const ref of agentTotals.keys()) if (!agents.has(ref)) agents.set(ref, emptyAgent(ref, sourceLabel(chosen.kind)));
    const summary: ReadSummary = {
      source: source ?? { kind: chosen.kind, fingerprint: hashOf(input.from === "files" ? input.files.entries : [input.source.kind, input.source.path, input.source.profile ?? ""]) },
      agents: [...agents.values()],
      leftovers,
      conversations: counts.conversations,
      messages: counts.messages,
    };
    for (const agent of summary.agents) totalsFor(agent.ref);
    writeFileSync(join(params.stagingDir, SUMMARY_FILE), JSON.stringify(summary), { mode: 0o600 });
    post({ type: "done", snapshot: snapshot() });
  } catch (error) {
    spool.destroy();
    post({ type: "error", code: error instanceof ImportUploadError ? error.code : "worker-failed" });
  } finally {
    clearInterval(heartbeat);
  }
}
