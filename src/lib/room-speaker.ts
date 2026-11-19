import type { Message } from "@/state/store";
import type { ActivityTranscriptItem } from "./activity-runs";
import { localDay } from "./transcript-derivations";

function isBotText(message: { role: string; kind: string; text?: string; attachments?: readonly unknown[]; from?: { botId: string } }): message is { role: "bot"; kind: "text"; text?: string; attachments?: readonly unknown[]; from: { botId: string }; at: number } {
  return message.role === "bot" && message.kind === "text" && Boolean(message.from?.botId) && Boolean(message.text?.trim() || message.attachments?.length);
}

/** The bot's own answer that follows a row of its work, when nobody else spoke in between. */
export function laterTextOf(items: readonly ActivityTranscriptItem[], index: number, botId: string, at: number): Message | undefined {
  for (let cursor = index + 1; cursor < items.length; cursor += 1) {
    const next = items[cursor];
    if (!next || next.kind !== "message") continue;
    const message = next.message;
    if (message.role === "user") return undefined;
    if (isBotText(message)) {
      return message.from.botId === botId && localDay(message.at) === localDay(at) ? message : undefined;
    }
  }
  return undefined;
}

function laterTextOwns(items: readonly ActivityTranscriptItem[], index: number, botId: string, at: number): boolean {
  return laterTextOf(items, index, botId, at) !== undefined;
}

/** `headFirst` (Advanced mode): a turn's head sits above its work card, so an answer that follows the card does not repeat it. */
export function botTextShowsSpeaker(items: readonly ActivityTranscriptItem[], index: number, headFirst?: { showToolCalls: boolean }): boolean {
  const item = items[index];
  if (!item || item.kind !== "message" || !isBotText(item.message)) return false;
  const message = item.message;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const prev = items[cursor];
    if (!prev) continue;
    if (prev.kind === "run") {
      const speaker = prev.messages[0]?.from?.botId;
      if (speaker && speaker !== message.from.botId) return true;
      if (headFirst && speaker && localDay(prev.messages[0]!.at) === localDay(message.at) && runShowsSpeaker(items, cursor, headFirst.showToolCalls, true)) return false;
      continue;
    }
    const earlier = prev.message;
    if (earlier.role === "user") return true;
    if (isBotText(earlier)) {
      if (earlier.from.botId !== message.from.botId) return true;
      return localDay(earlier.at) !== localDay(message.at);
    }
  }
  return true;
}

export function runShowsSpeaker(items: readonly ActivityTranscriptItem[], index: number, showToolCalls: boolean, headFirst = false): boolean {
  if (!showToolCalls) return false;
  const item = items[index];
  if (!item || item.kind !== "run") return false;
  const first = item.messages[0];
  const botId = first?.from?.botId;
  if (!botId || !first) return false;
  if (!headFirst && laterTextOwns(items, index, botId, first.at)) return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const prev = items[cursor];
    if (!prev) continue;
    if (prev.kind === "run") {
      const speaker = prev.messages[0]?.from?.botId;
      if (speaker === botId && localDay(prev.messages[0]!.at) === localDay(first.at)) return false;
      if (speaker && speaker !== botId) return true;
      continue;
    }
    const earlier = prev.message;
    if (earlier.role === "user") return true;
    if (isBotText(earlier)) {
      if (earlier.from.botId !== botId) return true;
      return localDay(earlier.at) !== localDay(first.at);
    }
  }
  return true;
}

export { laterTextOwns };
