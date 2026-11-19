import { useMemo, type Dispatch, type ReactNode } from "react";
import { api } from "@/state/api";
import type { Action, Bot, Message } from "@/state/store";
import { liveWorkSteps, type TranscriptItem } from "@/lib/activity-runs";
import { traceRootId } from "../../shared/usage-trace";
import { BotTurnHead } from "./BotTurnHead";
import { BOT_TURN_INDENT } from "./chat-bubble";

/** Advanced mode's work cards: where a running turn's open card starts in the transcript, and the trace each finished
 * turn's card links to (its separate digest row is then left out). */
export function useAdvancedTurns({ advanced, busy, showToolCalls, items, messages }: {
  advanced: boolean; busy: boolean; showToolCalls: boolean; items: readonly TranscriptItem[]; messages: readonly Message[];
}) {
  const liveStart = useMemo(() => {
    if (!advanced || !busy || !showToolCalls) return -1;
    const ids = new Set(liveWorkSteps(messages).map((message) => message.id));
    let start = items.length;
    while (start > 0) {
      const item = items[start - 1]!;
      if (!(item.kind === "message" ? ids.has(item.message.id) : item.kind === "run" && item.messages.every((step) => ids.has(step.id)))) break;
      start -= 1;
    }
    return start < items.length ? start : -1;
  }, [advanced, busy, showToolCalls, items, messages]);
  const traces = useMemo(() => {
    const byItem = new Map<string, { id: string; at: number }>(), absorbed = new Set<string>();
    if (!advanced || !showToolCalls) return { byItem, absorbed };
    const digests = new Map<string, Message>();
    for (const row of messages) if (row.kind === "digest" && row.digest) digests.set(row.digest.turnId, row);
    for (const item of items) {
      if (item.kind !== "turn") continue;
      const row = digests.get(item.turnId), digest = row?.digest;
      if (!row || !digest) continue;
      byItem.set(item.id, { id: traceRootId(digest.threadId, digest.turnId), at: digest.at });
      absorbed.add(row.id);
    }
    return { byItem, absorbed };
  }, [advanced, showToolCalls, items, messages]);
  return { liveStart, traces };
}

/** The rows a work card holds: a running turn's steps from its start to the end, or the folded rows of the item. */
export function cardRows(items: readonly TranscriptItem[], at: number, live: boolean): Message[] {
  const item = items[at]!;
  if (live) return items.slice(at).flatMap((one) => one.kind === "message" ? [one.message] : one.kind === "run" ? one.messages : []);
  return item.kind === "message" ? [] : item.messages;
}

/** The bot's turn head above its work card, unless a bubble of the same turn above already carries it. */
export function AdvancedTurnCard({ headed, bot, name, color, time, onOpen, children }: {
  headed: boolean; bot?: Bot; name: string; color: string; time: string; onOpen: () => void; children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col" data-turn-card>
      {headed && <div className={BOT_TURN_INDENT}><BotTurnHead bot={bot} name={name} color={color} time={time} onOpen={onOpen} /></div>}
      {children}
    </div>
  );
}

/** Saves a new name for the bot: through the host when this window is a paired client, in the store otherwise. */
export function renameBotWith(bot: Bot, dispatch: Dispatch<Action>): (name: string) => void {
  return (name) => {
    if (window.ogb?.remoteClient?.active) {
      void api<{ bot: Bot }>(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
        .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
        .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
    } else {
      dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
    }
  };
}
