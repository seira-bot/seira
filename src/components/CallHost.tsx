import { useEffect, useRef } from "react";

import { useOnCall } from "@/lib/call";
import { beginCallSession, patchCallSession, pushCaption, resetCallSession, useActiveCall } from "@/lib/call-session";
import { createCallTones } from "@/lib/call-tones";
import { isLiveCallRunning, useLiveMedia } from "@/lib/live-call-media";
import { useStore } from "@/state/store";
import { TurnsCall } from "./TurnsCall";

const LIVE_SPEAKING_MS = 1_500;

/** Owns the call that is running, whatever chat is open: the Turns call itself, the tones, and the captions of a Live call. */
export function CallHost() {
  const { state } = useStore();
  const media = useLiveMedia();
  const onCall = useOnCall();
  const call = useActiveCall();
  const tones = useRef(createCallTones());
  const live = isLiveCallRunning(media.phase) && media.botId ? media.botId : null;
  const turnsBot = !live && onCall ? state.bots.find((bot) => bot.id === onCall) : undefined;

  const stage = call?.stage ?? null;
  useEffect(() => {
    tones.current.update(stage ? { stage } : null);
  }, [stage]);

  useEffect(() => {
    if (live) beginCallSession(live);
    else if (!onCall) resetCallSession();
  }, [live, onCall]);

  useEffect(() => {
    if (!live) return;
    if (media.heard) pushCaption("you", media.heard);
  }, [live, media.heard]);

  useEffect(() => {
    if (!live || !media.caption) return;
    pushCaption("bot", media.caption);
    patchCallSession({ liveSpeaking: true });
    const timer = setTimeout(() => patchCallSession({ liveSpeaking: false }), LIVE_SPEAKING_MS);
    return () => clearTimeout(timer);
  }, [live, media.caption]);

  return turnsBot ? <TurnsCall key={turnsBot.id} bot={turnsBot} /> : null;
}
