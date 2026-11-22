import type { ReactNode, Ref } from "react";
import { AudioLines, Captions, Mic, MicOff, PhoneOff } from "lucide-react";

import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { liveCallChord } from "@/lib/live-call-media";
import { hangUpActiveCall, muteActiveCall, useCallClock, type ActiveCall } from "@/lib/call-session";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { CallVoicePanel } from "./CallVoicePanel";
import { callStatusLine, CaptionsPopover, SpeakingWave, useCallPopovers } from "./call-parts";

function PillButton({ label, icon, onClick, danger, active, buttonRef, expanded, chord, disabled }: {
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
      title={chord ? `${label} (${chord.text})` : label}
      aria-label={label}
      aria-keyshortcuts={chord?.aria}
      disabled={disabled}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      onClick={onClick}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60",
        danger ? "bg-danger text-white hover:brightness-110" : active ? "bg-ink text-app" : "text-ink hover:bg-raised",
      )}
    >
      {icon}
    </button>
  );
}

/** The call while it is minimized: one row at the top of the chat area. The face and the name open the full call view. */
export function CallPill({ bot, call, onOpen }: { bot: Bot; call: ActiveCall; onOpen: () => void }) {
  const popovers = useCallPopovers();
  const time = useCallClock(call.startedAt);
  const connected = call.stage === "connected";
  const chords = call.mode === "live" ? { mute: liveCallChord("mute", isMacPlatform()), hangUp: liveCallChord("hangUp", isMacPlatform()) } : undefined;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-[26] flex justify-center px-3">
      <div ref={popovers.root} role="group" aria-label={t("call.view.callWith", { name: bot.name })} className="pointer-events-auto relative flex h-11 max-w-full items-center gap-1 rounded-full border border-hairline/50 bg-panel px-1.5 shadow-lg">
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("call.view.open", { name: bot.name })}
          className="flex min-w-0 items-center gap-2 rounded-full pe-2 hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <BotAvatar bot={bot} size={32} />
          <span className="truncate text-[13px] font-medium text-ink">{bot.name}</span>
          <span className="shrink-0 text-[12px] tabular-nums text-ink-secondary">{callStatusLine(call, time)}</span>
          {connected && call.presence === "speaking" && <SpeakingWave />}
        </button>
        {popovers.open && (
          <div className="absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2">
            {popovers.open === "captions"
              ? <CaptionsPopover lines={call.captions} botName={bot.name} />
              : <CallVoicePanel bot={bot} call={call} />}
          </div>
        )}
        <PillButton
          label={t("call.voice.title")}
          icon={<AudioLines size={16} />}
          active={popovers.open === "voice"}
          expanded={popovers.open === "voice"}
          buttonRef={popovers.buttonRef("voice")}
          onClick={() => popovers.toggle("voice")}
        />
        {connected && (
          <PillButton
            label={t("call.view.captions")}
            icon={<Captions size={16} />}
            active={popovers.open === "captions"}
            expanded={popovers.open === "captions"}
            buttonRef={popovers.buttonRef("captions")}
            onClick={() => popovers.toggle("captions")}
          />
        )}
        {connected && (
          <PillButton
            label={call.muted ? t("call.live.unmute") : t("call.live.mute")}
            icon={call.muted ? <MicOff size={16} /> : <Mic size={16} />}
            active={call.muted}
            chord={chords?.mute}
            onClick={() => muteActiveCall(call, !call.muted)}
          />
        )}
        <PillButton label={t("call.live.hangUp")} icon={<PhoneOff size={16} />} danger chord={chords?.hangUp} disabled={call.presence === "ending"} onClick={() => hangUpActiveCall(call)} />
      </div>
    </div>
  );
}
