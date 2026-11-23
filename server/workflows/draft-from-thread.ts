import { randomUUID } from "node:crypto";

import { classifyToolCall } from "../../shared/today-outcomes.ts";
import { WORKFLOW_LIMITS, type DrawnWorkflow, type WorkflowConnection, type WorkflowStep } from "../../shared/workflows.ts";
import type { Assignment } from "../runtime/types.ts";

export interface DraftTurnRow { at: number; role: string; kind: string; from?: { botId: string }; tool?: { name: string; input?: string; ok?: boolean } }

export interface DraftSource {
  threadId: string;
  room: boolean;
  request: { at: number; text: string };
  reply: { at: number; botId: string };
  /** Roots and subtrees from Coordinator.job. */
  rows: readonly Assignment[];
  /** Rows of a conversation in [from, to]; null when the person may not see it. botId narrows a room. */
  turnRows(threadId: string, from: number, to: number, botId?: string): readonly DraftTurnRow[] | null;
  /** The person may open this conversation. A hand-off into one they may not open is left out: its brief quotes that work. */
  threadVisible(threadId: string): boolean;
  /** The person may chat with this bot and it still exists. */
  usable(botId: string): boolean;
}

const MENTION_PREFIX = /^Mentioned by .+? \(hop \d+\): /;
const ROW_STEP = 160;

type Event = { at: number; step: { kind: "bot"; botId: string; instruction: string } | { kind: "post" } };

export const withoutMention = (brief: string): string => brief.replace(MENTION_PREFIX, "");

/** The roots one reply answers: those started between the request and the reply. A 1:1 chat keeps its own bot's. */
export function windowRoots(rows: readonly Assignment[], source: Pick<DraftSource, "threadId" | "room" | "request" | "reply">): Assignment[] {
  return rows.filter((row) => !row.parentId
    && row.assignee.destination.threadId === source.threadId
    && row.createdAt >= source.request.at && row.createdAt <= source.reply.at
    && (source.room || row.assignee.botId === source.reply.botId));
}

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

const ATTACHMENT_TAG = /<attached-(?:image|file)\b[^>]*\/>/gi;
const PASTE_TAG = /<\/?pasted-text\b[^>]*>/gi;

/** A request without the tags the composer adds for attachments and pasted text; the words stay. */
export const plainRequest = (text: string): string => text.replace(ATTACHMENT_TAG, " ").replace(PASTE_TAG, " ").trim();

export function workflowName(requestText: string): string {
  const line = plainRequest(requestText).split(/\r?\n/).map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const chars = Array.from(line);
  if (chars.length <= WORKFLOW_LIMITS.name) return line;
  const room = chars.slice(0, WORKFLOW_LIMITS.name - 1).join("");
  const space = chars[WORKFLOW_LIMITS.name - 1] === " " ? room.length : room.lastIndexOf(" ");
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`;
}

const sends = (row: DraftTurnRow): boolean => {
  if (row.role !== "bot" || row.kind !== "activity" || !row.tool || row.tool.ok === false) return false;
  return classifyToolCall(row.tool.name, row.tool.input).some((outcome) => outcome === "emailSent" || outcome === "message");
};

export function draftFromThread(source: DraftSource, newId: (prefix: "s" | "c") => string = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`): DrawnWorkflow {
  const { threadId, room, request, reply } = source;
  const roots = windowRoots(source.rows, source);
  let omitted = 0;
  const openable = (row: Assignment, becomesStep = true): boolean => {
    if (source.threadVisible(row.assignee.destination.threadId)) return true;
    if (becomesStep) omitted += 1;
    return false;
  };
  const rootIds = new Set(roots.map((root) => root.id));
  const handOffs = source.rows.filter((row) => row.parentId !== undefined && rootIds.has(row.rootId)
    && row.status !== "cancelled" && row.outcome !== "refused" && row.outcome !== "duplicate" && openable(row, row.assignee.botId !== row.requester.botId));
  const events: Event[] = [{ at: Number.NEGATIVE_INFINITY, step: { kind: "bot", botId: roots[0]?.assignee.botId ?? reply.botId, instruction: plainRequest(request.text) } }];

  for (const row of handOffs) {
    if (row.assignee.botId !== row.requester.botId) events.push({ at: row.createdAt, step: { kind: "bot", botId: row.assignee.botId, instruction: row.brief } });
  }
  if (room) {
    for (const row of roots.slice(1).filter((row) => openable(row))) events.push({ at: row.createdAt, step: { kind: "bot", botId: row.assignee.botId, instruction: withoutMention(row.brief) } });
  }

  const seen = new Set<string>();
  const readPosts = (target: string, from: number, to: number, botId: string | undefined, owners: readonly Assignment[], fallbackAt: number) => {
    const found = source.turnRows(target, from, to, botId);
    if (found === null) return;
    if (found.length === 0) {
      if (owners.some((owner) => (owner.evidence?.outward ?? []).some((label) => classifyToolCall(label).some((outcome) => outcome === "emailSent" || outcome === "message")))) {
        events.push({ at: fallbackAt, step: { kind: "post" } });
      }
      return;
    }
    for (const row of found) {
      const key = `${target}|${row.at}|${row.tool?.name}|${row.tool?.input ?? ""}|${botId ?? ""}`;
      if (!sends(row) || seen.has(key)) continue;
      seen.add(key);
      events.push({ at: row.at, step: { kind: "post" } });
    }
  };

  if (room) {
    for (const root of roots) readPosts(threadId, root.startedAt ?? root.createdAt, root.finishedAt ?? reply.at, root.assignee.botId, [root], root.finishedAt ?? root.createdAt);
  } else {
    readPosts(threadId, request.at, reply.at, undefined, roots, reply.at);
  }
  for (const row of handOffs) {
    const target = row.assignee.destination.threadId;
    if (!room && target === threadId) continue;
    readPosts(target, row.startedAt ?? row.createdAt, row.finishedAt ?? reply.at, row.assignee.destination.groupId ? row.assignee.botId : undefined, [row], row.finishedAt ?? row.createdAt);
  }

  events.sort((a, b) => a.at - b.at);

  const kept: Event["step"][] = [];
  for (const { step } of events) {
    if (step.kind === "bot") {
      if (!source.usable(step.botId)) { omitted += 1; continue; }
      const instruction = step.instruction.trim();
      if (!instruction) continue;
      kept.push({ ...step, instruction: clip(instruction, WORKFLOW_LIMITS.instruction) });
    } else if (kept.at(-1)?.kind !== "post") {
      kept.push(step);
    }
  }

  const shown = kept.slice(0, WORKFLOW_LIMITS.steps);
  const steps: WorkflowStep[] = shown.map((step, index) => ({ id: newId("s"), position: { x: 0, y: index * ROW_STEP }, ...step }));
  const connections: WorkflowConnection[] = steps.slice(1).map((step, index) => ({ id: newId("c"), from: steps[index]!.id, to: step.id }));
  return { draft: { name: workflowName(request.text), steps, connections }, omitted, trimmed: kept.length - shown.length };
}
