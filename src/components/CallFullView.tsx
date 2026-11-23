import { useEffect, type ReactNode, type Ref } from "react";
import { AudioLines, Captions, Mic, MicOff, Minimize2, PhoneOff } from "lucide-react";

import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { liveCallChord } from "@/lib/live-call-media";
import { hangUpActiveCall, muteActiveCall, setCallMinimized, turnsActions, useCallClock, type ActiveCall } from "@/lib/call-session";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { pushToTalkKeys } from "@/lib/push-to-talk";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { CallVoicePanel } from "./CallVoicePanel";
import { callStatusLine, CaptionsPopover, useCallPopovers } from "./call-parts";

function RoundControl({ label, icon, onClick, danger, active, buttonRef, expanded, chord, disabled }: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  expanded?: boolean;
  chord?: { aria: string; text: string };
  disabled?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={chord ? `${label} (${chord.text})` : undefined}
      aria-keyshortcuts={chord?.aria}
      disabled={disabled}
      onClick={onClick}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      className="group flex w-16 flex-col items-center gap-1.5 rounded-lg focus-visible:outline-none disabled:opacity-60"
    >
      <span
        className={cn(
          "flex size-11 items-center justify-center rounded-full group-focus-visible:ring-2 group-focus-visible:ring-focus",
          danger ? "bg-danger text-white group-hover:brightness-110" : active ? "bg-ink text-app" : "bg-raised text-ink group-hover:bg-raised/80",
        )}
      >
        {icon}
      </span>
      <span className="text-[12px] leading-4 text-ink-secondary">{label}</span>
    </button>
  );
}

export function CallFullView({ bot, call }: { bot: Bot; call: ActiveCall }) {
  const popovers = useCallPopovers();
  const time = useCallClock(call.startedAt);
  const connected = call.stage === "connected";
  const chords = call.mode === "live" ? { mute: liveCallChord("mute", isMacPlatform()), hangUp: liveCallChord("hangUp", isMacPlatform()) } : undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || popovers.openRef.current) return;
      event.preventDefault();
      hangUpActiveCall(call);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [call, popovers.openRef]);

  const mascot = call.presence === "speaking" ? "sending" : call.presence === "thinking" ? "thinking" : "listening";
  const prompt = connected && call.mode === "turns" && call.presence === "listening" && !call.text
    ? (call.pushToTalk ? t("call.turns.releaseToSend", { keys: pushToTalkKeys() }) : t("call.turns.saySomething"))
    : null;

  return (
    <div role="dialog" aria-label={t("call.view.callWith", { name: bot.name })} className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <div className="relative inline-flex">
        {!connected && [0, 1, 2].map((ring) => (
          <span key={ring} aria-hidden className={cn("call-ring absolute inset-0 rounded-full border-2 border-accent/50", ring === 1 && "call-ring-2", ring === 2 && "call-ring-3")} />
        ))}
        {connected && call.presence === "speaking" && <span aria-hidden className="call-halo absolute -inset-4 rounded-full bg-accent/20" />}
        <BotAvatar bot={bot} state={mascot} size={220} animated trackPointer />
      </div>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div role="status" className="text-[14px] tabular-nums text-ink-secondary">{callStatusLine(call, time)}</div>
      </div>

      <div className="min-h-[3.5rem] max-w-xl px-6 text-center text-[15px] leading-relaxed text-ink">
        {connected && call.text ? call.text : prompt && <span className="text-ink-secondary">{prompt}</span>}
      </div>

      {call.note && (
        <div className="flex max-w-md flex-col items-center gap-2 text-center text-[13px] text-warning">
          <span>{call.note}</span>
          {call.mode === "turns" && (
            <button type="button" onClick={() => turnsActions.retry?.()} className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10">
              {t("call.turns.tryMicrophone")}
            </button>
          )}
        </div>
      )}
      {call.speechError && <div className="max-w-md text-center text-[13px] text-danger">{call.speechError}</div>}

      {call.canInterrupt && (
        <button type="button" onClick={() => turnsActions.interrupt?.()} className="rounded-full border border-hairline/50 px-4 py-2 text-[14px] text-ink hover:bg-raised">
          {t("call.turns.interrupt")}
        </button>
      )}

      <div ref={popovers.root} className="relative flex items-start justify-center gap-4">
        {popovers.open && (
          <div className="absolute bottom-full left-1/2 z-10 mb-4 -translate-x-1/2">
            {popovers.open === "captions"
              ? <CaptionsPopover lines={call.captions} botName={bot.name} />
              : <CallVoicePanel bot={bot} call={call} />}
          </div>
        )}
        {connected && (
          <RoundControl
            label={call.muted ? t("call.live.unmute") : t("call.live.mute")}
            icon={call.muted ? <MicOff size={20} /> : <Mic size={20} />}
            active={call.muted}
            chord={chords?.mute}
            onClick={() => muteActiveCall(call, !call.muted)}
          />
        )}
        {connected && (
          <RoundControl
            label={t("call.view.captions")}
            icon={<Captions size={20} />}
            active={popovers.open === "captions"}
            expanded={popovers.open === "captions"}
            buttonRef={popovers.buttonRef("captions")}
            onClick={() => popovers.toggle("captions")}
          />
        )}
        <RoundControl
          label={t("call.voice.title")}
          icon={<AudioLines size={20} />}
          active={popovers.open === "voice"}
          expanded={popovers.open === "voice"}
          buttonRef={popovers.buttonRef("voice")}
          onClick={() => popovers.toggle("voice")}
        />
        <RoundControl label={t("call.view.minimize")} icon={<Minimize2 size={20} />} onClick={() => setCallMinimized(true)} />
        <RoundControl label={t("call.live.hangUp")} icon={<PhoneOff size={20} />} danger chord={chords?.hangUp} disabled={call.presence === "ending"} onClick={() => hangUpActiveCall(call)} />
      </div>

      {call.mode === "turns" && connected && (
        <div className="text-[12px] text-ink-tertiary">{t("call.turns.keysHint", { keys: pushToTalkKeys() })}</div>
      )}
    </div>
  );
}
