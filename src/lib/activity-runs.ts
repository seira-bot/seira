import type { Message } from "@/state/store";
import { formatElapsed } from "@/lib/working-time";
import { t } from "@/lib/i18n";
import { activityText } from "@/lib/activity-text";
import { failedTurnCause } from "../../shared/failed-turn";
import { isCancelledTranscriptRow, isStoppedTurnName } from "../../shared/client-cancel";
import { localDay } from "@/lib/transcript-derivations";

export type ActivityTranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

export type TranscriptItem =
  | ActivityTranscriptItem
  | { kind: "turn"; id: string; turnId: string; label: string; durationMs: number; messages: Message[] };

export function statusActivity(message: Message): { kind: "recovery" | "notice" | "stopped"; text: string } | null {
  const tool = message.kind === "activity" ? message.tool : undefined;
  const name = tool?.name;
  if (name?.startsWith("recovery:")) return { kind: "recovery", text: activityText(tool!, name.slice("recovery:".length).trim()) };
  if (name?.startsWith("notice:")) return { kind: "notice", text: activityText(tool!, name.slice("notice:".length).trim()) };
  if (name && isStoppedTurnName(name)) return { kind: "stopped", text: name.slice("stopped:".length).trim() };
  return null;
}

export function isRecoveryActivity(message: Message): boolean {
  return statusActivity(message)?.kind === "recovery";
}

export function isStatusActivity(message: Message): boolean {
  return statusActivity(message) !== null;
}

export function isToolStep(message: Message): message is Message & { tool: NonNullable<Message["tool"]> } {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef || message.relay || message.dataResult || isStatusActivity(message)) return false;
  return failedTurnCause(tool.name) === null;
}

function foldable(message: Message): boolean {
  return isToolStep(message) && message.tool.ok === true;
}

type TurnFold = Extract<TranscriptItem, { kind: "turn" }>;

const isNarration = (message: Message, turnId: string) =>
  message.role === "bot" && message.kind === "text" && message.turnId === turnId && !message.turnTerminal;

/** A turn starts with the person's last message before its first row, or with that row when nobody wrote first. */
function turnStartedAt(messages: readonly Message[], firstIndex: number, fallback: number): number {
  for (let i = firstIndex - 1; i >= 0; i -= 1) if (messages[i]!.role === "user") return messages[i]!.at;
  return messages[firstIndex]?.at ?? fallback;
}

/** "Worked for 29s", or plain "Worked" for a turn under a second. */
export function workedLabel(elapsed: number): string {
  return elapsed >= 1_000 ? t("chat.run.workedFor", { elapsed: formatElapsed(elapsed) }) : t("chat.run.worked");
}

/** How long each finished turn took, keyed by its answer's id: from its start to the answer. */
export function turnDurations(messages: readonly Message[]): Map<string, number> {
  const firstIndex = new Map<string, number>();
  const durations = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.turnId) return;
    if (!firstIndex.has(message.turnId)) firstIndex.set(message.turnId, index);
    if (message.role !== "bot" || message.kind !== "text" || !message.turnTerminal) return;
    durations.set(message.id, Math.max(0, message.at - turnStartedAt(messages, firstIndex.get(message.turnId)!, message.at)));
  });
  return durations;
}

/** Once a turn has its answer, the rows `folded` picks go behind one "Worked for 29s" chip at the first of them. */
function settledTurnFolds(messages: Message[], folded: (message: Message, turnId: string) => boolean): {
  byAnchorId: Map<string, TurnFold>;
  hiddenIds: Set<string>;
} {
  const byAnchorId = new Map<string, TurnFold>();
  const hiddenIds = new Set<string>();

  messages.forEach((terminal, terminalIndex) => {
    if (
      terminal.role !== "bot" ||
      terminal.kind !== "text" ||
      !terminal.turnId ||
      !terminal.turnTerminal
    ) return;
    const turnId = terminal.turnId;
    const before = messages.slice(0, terminalIndex);
    const rows = before.filter((message) => folded(message, turnId));
    if (!rows.length) return;

    const firstIndex = before.findIndex((message) => message.turnId === turnId);
    const startedAt = turnStartedAt(messages, firstIndex, rows[0].at);
    const durationMs = Math.max(0, terminal.at - startedAt);
    const label = workedLabel(durationMs);
    byAnchorId.set(rows[0].id, { kind: "turn", id: `turn:${turnId}`, turnId, label, durationMs, messages: rows });
    for (const message of rows) hiddenIds.add(message.id);
  });

  return { byAnchorId, hiddenIds };
}

/** A room shows a member's answer, not its working notes. */
function assistantTurnFolds(messages: Message[]) {
  return settledTurnFolds(messages, isNarration);
}

/** A conversation keeps the bot's own progress lines and folds only its finished tool steps. */
function toolStepFolds(messages: Message[]) {
  return settledTurnFolds(messages, (message, turnId) => message.turnId === turnId && foldable(message));
}

export function roomTurnFolds(messages: Message[]): {
  byTerminalId: Map<string, TurnFold>;
  hiddenIds: Set<string>;
} {
  const { byAnchorId, hiddenIds } = assistantTurnFolds(messages);
  const terminals = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "bot" && message.kind === "text" && message.turnId && message.turnTerminal) terminals.set(message.turnId, message.id);
  }
  const byTerminalId = new Map<string, TurnFold>();
  for (const fold of byAnchorId.values()) {
    const terminalId = terminals.get(fold.turnId);
    if (terminalId) byTerminalId.set(terminalId, fold);
  }
  return { byTerminalId, hiddenIds };
}

function group(messages: Message[], foldAssistantTurns: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const folds = foldAssistantTurns
    ? toolStepFolds(messages)
    : { byAnchorId: new Map<string, TurnFold>(), hiddenIds: new Set<string>() };
  let run: Message[] = [];
  const flush = () => {
    if (run.length > 1) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    const turn = folds.byAnchorId.get(message.id);
    if (turn) {
      flush();
      items.push(turn);
      continue;
    }
    if (folds.hiddenIds.has(message.id) || message.reaction) continue;
    if (foldable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          localDay(first.at) !== localDay(message.at))
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

export function groupActivityRuns(messages: Message[]): ActivityTranscriptItem[] {
  return group(messages, false) as ActivityTranscriptItem[];
}

export function groupTranscript(messages: Message[]): TranscriptItem[] {
  return group(messages, true);
}

const MAX_NAMES = 3;

export function describeRun(messages: Message[], label: (tool: NonNullable<Message["tool"]>) => string = (tool) => tool.label ?? activityText(tool, tool.name)): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const name = message.tool ? label(message.tool) : "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length > MAX_NAMES ? ` ${t("chat.run.more", { count: names.length - MAX_NAMES })}` : "";
  const tools = `${shown}${rest}`;
  return messages.length === 1 ? `${t("chat.run.stepOne")} · ${tools}` : t("chat.run.steps", { count: messages.length, tools });
}

export type RunStatus = "done" | "working" | "failed";

/** The tool steps at the end of the transcript that nothing has answered yet: the work card of a turn still running. */
export function liveWorkSteps(messages: readonly Message[]): Message[] {
  let start = messages.length;
  while (start > 0 && isToolStep(messages[start - 1]!) && !isCancelledTranscriptRow(messages[start - 1]!)) start -= 1;
  return messages.slice(start);
}

export function runStatus(messages: readonly Message[]): RunStatus {
  return messages.some((message) => message.tool?.ok === false) ? "failed" : "done";
}

/** The head of Advanced mode's work card: "Worked for 29s", "Working…" or "Failed after 4s". */
export function runHeadline(messages: readonly Message[], status: RunStatus, label?: string, recordedMs?: number): string {
  if (status === "working") return t("chat.run.working");
  const elapsed = recordedMs ?? (messages.length > 1 ? Math.max(0, messages[messages.length - 1]!.at - messages[0]!.at) : 0);
  if (status === "failed") return elapsed >= 1_000 ? t("chat.run.failedAfter", { elapsed: formatElapsed(elapsed) }) : t("toolDetail.failed");
  return label ?? workedLabel(elapsed);
}

export function stepCountLabel(count: number): string {
  return count === 1 ? t("chat.run.stepOne") : t("chat.run.stepMany", { count });
}
