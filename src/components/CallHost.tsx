import { useEffect, useRef } from "react";

import { useOnCall } from "@/lib/call";
import { beginCallSession, resetCallSession, useActiveCall, watchLiveCaptions } from "@/lib/call-session";
import { createCallTones } from "@/lib/call-tones";
import { isLiveCallRunning, useLiveMedia } from "@/lib/live-call-media";
import { useStore } from "@/state/store";
import { TurnsCall } from "./TurnsCall";

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

  useEffect(() => (live ? watchLiveCaptions() : undefined), [live]);

  return turnsBot ? <TurnsCall key={turnsBot.id} bot={turnsBot} /> : null;
}
