import type { Message } from "@/state/store";
import { traceRootId } from "../../shared/usage-trace";
import type { ActivityTranscriptItem } from "./activity-runs";

/** The trace each work card of a room links to, and the digest rows those cards make redundant. A card takes the digest
 * of the last turn it holds; a digest no card holds stays a row of its own. */
export function roomRunTraces(items: readonly ActivityTranscriptItem[], messages: readonly Message[]): {
  byRun: Map<string, { id: string; at: number; durationMs?: number }>;
  absorbed: Set<string>;
} {
  const digests = new Map<string, Message>();
  for (const row of messages) if (row.kind === "digest" && row.digest) digests.set(row.digest.turnId, row);
  const runOf = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "run") continue;
    const last = item.messages.findLast((step) => step.turnId !== undefined && digests.has(step.turnId));
    if (last?.turnId) runOf.set(last.turnId, item.id);
  }
  const byRun = new Map<string, { id: string; at: number; durationMs?: number }>();
  const absorbed = new Set<string>();
  for (const [turnId, runId] of runOf) {
    const row = digests.get(turnId)!;
    const digest = row.digest!;
    byRun.set(runId, { id: traceRootId(digest.threadId, digest.turnId), at: digest.at, ...(digest.durationMs > 0 ? { durationMs: digest.durationMs } : {}) });
    absorbed.add(row.id);
  }
  return { byRun, absorbed };
}
