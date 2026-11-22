// What the call view and the call pill show about the call that is running, for a Turns call and a Live call alike.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { LiveCallState } from "../../shared/wire";
import { endCall, useOnCall } from "./call";
import { hangUpLiveCall, isLiveCallRunning, liveMedia, setLiveMuted, subscribeLiveMedia, useLiveMedia, type LiveMediaState } from "./live-call-media";
import { useSpeech } from "./tts/useSpeech";

export type CallStage = "calling" | "connected";
export type CallPresence = "listening" | "thinking" | "speaking" | "muted" | "ending";
export type CaptionWho = "bot" | "you";

export interface CaptionLine {
  id: number;
  who: CaptionWho;
  text: string;
}

export const CAPTION_LINES_SHOWN = 4;
const CAPTION_LINES_KEPT = 40;
const LONG_CAPTION_CHARS = 120;
const CAPTION_HEAD_CHARS = 48;
const LIVE_SPEAKING_MS = 1_500;

export interface CallSessionState {
  botId: string | null;
  stage: CallStage;
  presence: CallPresence;
  startedAt: number | null;
  muted: boolean;
  heard: string;
  note: string | null;
  pushToTalk: boolean;
  canInterrupt: boolean;
  minimized: boolean;
  captions: readonly CaptionLine[];
  liveSpeaking: boolean;
}

const EMPTY: CallSessionState = {
  botId: null, stage: "calling", presence: "listening", startedAt: null, muted: false, heard: "", note: null,
  pushToTalk: false, canInterrupt: false, minimized: false, captions: [], liveSpeaking: false,
};

let session: CallSessionState = EMPTY;
let lineId = 0;
const watchers = new Set<() => void>();

function commit(next: CallSessionState): void {
  session = next;
  for (const watcher of Array.from(watchers)) watcher();
}

export function callSession(): CallSessionState {
  return session;
}

export function subscribeCallSession(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function patchCallSession(patch: Partial<CallSessionState>): void {
  commit({ ...session, ...patch });
}

/** A new call starts full screen, with empty captions. */
export function beginCallSession(botId: string): void {
  if (session.botId === botId) return;
  commit({ ...EMPTY, botId });
}

export function resetCallSession(): void {
  if (session !== EMPTY) commit(EMPTY);
}

export function setCallMinimized(minimized: boolean): void {
  if (session.minimized !== minimized) commit({ ...session, minimized });
}

/** One utterance grows as the recognizer or the voice sends more of it, so a line that the new text extends, or that a window which moved on still overlaps, is replaced; anything else is a new line. */
export function foldCaption(lines: readonly CaptionLine[], who: CaptionWho, text: string, nextId: () => number): readonly CaptionLine[] {
  const clean = text.trim();
  if (!clean) return lines;
  const last = lines[lines.length - 1];
  if (last && last.who === who) {
    if (clean.startsWith(last.text) || last.text.startsWith(clean)) {
      if (last.text === clean) return lines;
      return [...lines.slice(0, -1), { ...last, text: clean.length >= last.text.length ? clean : last.text }];
    }
    if (clean.length >= LONG_CAPTION_CHARS && last.text.includes(clean.slice(0, CAPTION_HEAD_CHARS))) {
      return [...lines.slice(0, -1), { ...last, text: clean }];
    }
  }
  return [...lines, { id: nextId(), who, text: clean }].slice(-CAPTION_LINES_KEPT);
}

export function pushCaption(who: CaptionWho, text: string): void {
  const captions = foldCaption(session.captions, who, text, () => ++lineId);
  if (captions !== session.captions) commit({ ...session, captions });
}

/** Turns the captions of a Live call into lines. Reads every change of the store, so two changes in one task both reach the list. */
export function watchLiveCaptions(subscribe: (watcher: () => void) => () => void = subscribeLiveMedia, read: () => Pick<LiveMediaState, "heard" | "caption"> = liveMedia): () => void {
  let before = read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribe(() => {
    const after = read();
    if (after.heard && after.heard !== before.heard) pushCaption("you", after.heard);
    if (after.caption && after.caption !== before.caption) {
      pushCaption("bot", after.caption);
      patchCallSession({ liveSpeaking: true });
      clearTimeout(timer);
      timer = setTimeout(() => patchCallSession({ liveSpeaking: false }), LIVE_SPEAKING_MS);
    }
    before = after;
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}

export function lastCaptions(lines: readonly CaptionLine[]): readonly CaptionLine[] {
  return lines.slice(-CAPTION_LINES_SHOWN);
}

/** Set by the Turns call while it runs; the call view reads them to retry the microphone and to cut the bot off. */
export const turnsActions: { retry: (() => void) | null; interrupt: (() => void) | null } = { retry: null, interrupt: null };

export interface ActiveCall {
  mode: "turns" | "live";
  botId: string;
  stage: CallStage;
  presence: CallPresence;
  startedAt: number | null;
  muted: boolean;
  /** What the person said or the bot is saying right now. */
  text: string;
  textIsHeard: boolean;
  note: string | null;
  pushToTalk: boolean;
  canInterrupt: boolean;
  minimized: boolean;
  captions: readonly CaptionLine[];
  speechError: string | null;
}

export function liveCallPresence(media: Pick<LiveMediaState, "muted" | "heard" | "phase">, speaking: boolean): CallPresence {
  if (media.phase === "ending") return "ending";
  if (media.muted) return "muted";
  if (media.heard) return "listening";
  return speaking ? "speaking" : "listening";
}

export function useCallSession(): CallSessionState {
  return useSyncExternalStore(subscribeCallSession, callSession, callSession);
}

export function useActiveCall(): ActiveCall | null {
  const media = useLiveMedia();
  const onCall = useOnCall();
  const shared = useCallSession();
  const speech = useSpeech();
  if (isLiveCallRunning(media.phase) && media.botId) {
    return {
      mode: "live",
      botId: media.botId,
      stage: media.phase === "starting" ? "calling" : "connected",
      presence: liveCallPresence(media, shared.liveSpeaking),
      startedAt: media.startedAt,
      muted: media.muted,
      text: media.heard || media.caption,
      textIsHeard: Boolean(media.heard),
      note: media.notice,
      pushToTalk: false,
      canInterrupt: false,
      minimized: shared.minimized,
      captions: shared.captions,
      speechError: null,
    };
  }
  if (onCall && shared.botId === onCall) {
    const listening = shared.presence === "listening" && !shared.muted;
    return {
      mode: "turns",
      botId: onCall,
      stage: shared.stage,
      presence: shared.muted ? "muted" : shared.presence,
      startedAt: shared.startedAt,
      muted: shared.muted,
      text: listening ? shared.heard : speech.caption ?? "",
      textIsHeard: listening,
      note: shared.note,
      pushToTalk: shared.pushToTalk,
      canInterrupt: shared.canInterrupt,
      minimized: shared.minimized,
      captions: shared.captions,
      speechError: speech.error ?? null,
    };
  }
  return null;
}

export function muteActiveCall(call: Pick<ActiveCall, "mode">, muted: boolean): void {
  if (call.mode === "live") setLiveMuted(muted);
  else patchCallSession({ muted });
}

export function hangUpActiveCall(call: Pick<ActiveCall, "mode" | "botId">): void {
  if (call.mode === "live") void hangUpLiveCall();
  else endCall(call.botId);
}

export function formatCallTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The call time as m:ss, ticking each second; empty until the call connects. */
export function useCallClock(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? "" : formatCallTime(now - startedAt);
}

export function liveBadgeFor(botId: string, media: LiveMediaState, server: LiveCallState | null): boolean {
  if (media.botId === botId && isLiveCallRunning(media.phase)) return true;
  return Boolean(server && server.status !== "ended" && server.botId === botId);
}
