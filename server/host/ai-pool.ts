import { readFileSync } from "node:fs";

import type { ModelSelection } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { AI_POOL_LEVELS, pickPoolMember, type AiPoolConfig, type PoolReason } from "../ai-pool.ts";

const MAX_TRACKED_THREADS = 2000;

interface ThreadRecord { instanceId: string; model: string; level: number; until: number | null }

export interface AiPoolDeps {
  file?: string;
  maxTrackedThreads?: number;
  config(): AiPoolConfig | undefined;
  threadModel(botId: string, threadId: string): ModelSelection | null;
  botModel(botId: string): ModelSelection | null;
  reading(instanceId: string): { remaining: number | null; resetsAt: number | null };
  paid(instanceId: string): boolean;
  canRun(botId: string, threadId: string, from: ModelSelection, to: ModelSelection): boolean;
  moveTo(botId: string, threadId: string, from: ModelSelection, to: ModelSelection): boolean;
  note(threadId: string, line: string): void;
  engineName(instanceId: string): string;
  now?(): number;
}

function loadRecords(file: string | undefined): Map<string, ThreadRecord> {
  const records = new Map<string, ThreadRecord>();
  if (!file) return records;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<ThreadRecord>> | null;
    for (const [threadId, record] of Object.entries(saved ?? {})) {
      if (typeof record?.instanceId === "string" && typeof record.model === "string" && Number.isFinite(record.level) && (record.until === null || Number.isFinite(record.until))) {
        records.set(threadId, { instanceId: record.instanceId, model: record.model, level: record.level!, until: record.until! });
      }
    }
  } catch {
    return records;
  }
  return records;
}

export function poolNote(reason: PoolReason, from: string, to: string): string {
  switch (reason) {
    case "cannotRun": return `${from} can't take this turn, so this conversation moved to ${to}.`;
    case "low": return `${from} is low on usage, so this conversation moved to ${to}.`;
    case "payPerUse": return `${from} is pay-per-use, so this conversation moved to ${to}.`;
    case "order": return `${to} comes first in the AI pool, so this conversation moved from ${from} to ${to}.`;
    default: return `${to} has more usage left, so this conversation moved from ${from} to ${to}.`;
  }
}

export function createAiPool(deps: AiPoolDeps) {
  const now = deps.now ?? Date.now;
  const records = loadRecords(deps.file);
  const save = () => {
    if (!deps.file) return;
    try {
      writeFileAtomic(deps.file, JSON.stringify(Object.fromEntries(records)), { mode: 0o600, durable: false });
    } catch (error) {
      console.error(`ai pool: could not save threads: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const write = (threadId: string, next: ThreadRecord | null) => {
    const before = records.get(threadId);
    const unchanged = next && before && before.instanceId === next.instanceId && before.model === next.model && before.level === next.level && before.until === next.until;
    records.delete(threadId);
    if (next) records.set(threadId, next);
    if (unchanged) return;
    while (records.size > (deps.maxTrackedThreads ?? MAX_TRACKED_THREADS)) records.delete(records.keys().next().value!);
    save();
  };
  const active = () => {
    const pool = deps.config();
    return pool?.enabled && pool.members.length >= 2 ? pool : undefined;
  };

  return {
    place(botId: string, threadId: string): boolean {
      const pool = active(), current = deps.threadModel(botId, threadId);
      if (!pool || !current) return false;
      const currentIndex = pool.members.findIndex((member) => member.instanceId === current.instanceId);
      const record = records.get(threadId);
      if (currentIndex === -1 || (record && (record.instanceId !== current.instanceId || record.model !== current.model))) {
        if (record) write(threadId, null);
        return false;
      }
      if (!record) {
        const own = deps.botModel(botId);
        if (!own || own.instanceId !== current.instanceId || own.model !== current.model) return false;
      }
      const at = now();
      const readings = pool.members.map((member) => deps.reading(member.instanceId));
      const recordFor = (index: number, level: number): ThreadRecord => {
        const resetsAt = readings[index]!.resetsAt;
        return { instanceId: pool.members[index]!.instanceId, model: index === currentIndex ? current.model : pool.members[index]!.model, level, until: resetsAt !== null && resetsAt > at ? resetsAt : null };
      };
      const members = pool.members.map((member, index) => ({
        eligible: deps.canRun(botId, threadId, current, index === currentIndex ? current : member),
        paid: deps.paid(member.instanceId),
        ...readings[index]!,
      }));
      const threadLevel = record && record.until !== null && record.until > at ? record.level : undefined;
      const picked = pickPoolMember({ mode: pool.mode, levels: pool.levels ?? AI_POOL_LEVELS, floor: pool.floor ?? 0, members, currentIndex, threadLevel });
      if (picked.index === currentIndex) {
        write(threadId, recordFor(currentIndex, picked.threadLevel));
        return false;
      }
      const to = pool.members[picked.index]!;
      if (!deps.moveTo(botId, threadId, current, to)) return false;
      write(threadId, recordFor(picked.index, picked.threadLevel));
      deps.note(threadId, poolNote(picked.reason, deps.engineName(current.instanceId), deps.engineName(to.instanceId)));
      return true;
    },
    backupsFor(from: ModelSelection): ModelSelection[] {
      const pool = active();
      if (!pool?.members.some((member) => member.instanceId === from.instanceId)) return [];
      const others = pool.members.filter((member) => member.instanceId !== from.instanceId);
      return [...others.filter((member) => !deps.paid(member.instanceId)), ...others.filter((member) => deps.paid(member.instanceId))];
    },
  };
}
