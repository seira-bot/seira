import { useEffect, useSyncExternalStore } from "react";

import type { BoardCard, BoardView } from "../../shared/board";
import type { ServerFrame } from "../../shared/wire";
import { listenLiveFrames } from "@/lib/live-events";
import { randomUuid } from "@/lib/random-uuid";
import { api } from "@/state/api";

export interface BoardState {
  loaded: boolean;
  failed: boolean;
  cards: BoardCard[];
  /** The bot whose work is shown; null shows every bot. */
  botId: string | null;
}

const REREAD_MS = 800;
const LIVE_KINDS: ReadonlySet<ServerFrame["kind"]> = new Set(["bot", "group", "routine.run"]);

let state: BoardState = { loaded: false, failed: false, cards: [], botId: null };
const listeners = new Set<() => void>();
let reading: Promise<void> | null = null;
let readAgain = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let watchers = 0;
let stopListening: (() => void) | null = null;

function set(next: BoardState): void {
  state = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;

export function loadBoard(options: { background?: boolean } = {}): Promise<void> {
  if (reading) { readAgain = true; return reading; }
  reading = (async () => {
    try {
      do {
        readAgain = false;
        try {
          const view = await api<BoardView>("/api/board", options.background ? { background: true } : undefined);
          set({ ...state, loaded: true, failed: false, cards: Array.isArray(view?.cards) ? view.cards : [] });
        } catch {
          set({ ...state, failed: true });
        }
      } while (readAgain);
    } finally {
      reading = null;
    }
  })();
  return reading;
}

function scheduleRead(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void loadBoard({ background: true }); }, REREAD_MS);
}

/** Keeps the Board current while something shows it. Returns the function that stops. */
export function watchBoard(): () => void {
  watchers++;
  if (watchers === 1) {
    stopListening = listenLiveFrames({
      onFrame: (frame) => { if (LIVE_KINDS.has(frame.kind)) scheduleRead(); },
      onMissedFrames: scheduleRead,
    });
  }
  void loadBoard();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers--;
    if (watchers > 0) return;
    stopListening?.();
    stopListening = null;
    if (timer) { clearTimeout(timer); timer = null; }
  };
}

export function useBoardView(): BoardState {
  useEffect(() => watchBoard(), []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const useBoardFilter = (): string | null => useSyncExternalStore(subscribe, () => state.botId, () => state.botId);

export function setBoardFilter(botId: string | null): void {
  if (state.botId !== botId) set({ ...state, botId });
}

export function resetBoardForTest(): void {
  if (timer) clearTimeout(timer);
  timer = null; reading = null; readAgain = false; watchers = 0;
  stopListening?.(); stopListening = null;
  state = { loaded: false, failed: false, cards: [], botId: null };
  listeners.clear();
}

/** Makes a conversation for the bot, then sends the text into it as the first message. */
export async function createBoardTask(botId: string, text: string): Promise<void> {
  const made = await api<{ task?: { threadId?: string } }>(`/api/bots/${botId}/tasks`, { method: "POST", body: JSON.stringify({ select: false }) });
  const threadId = made?.task?.threadId;
  if (!threadId) throw new Error("No task");
  await api(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text, threadId, sendId: randomUuid() }) });
  void loadBoard({ background: true });
}
