import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";

import {
  botCallVoice,
  GEMINI_LIVE_VOICE_OPTIONS,
  geminiLiveVoice,
  LIVE_VOICE_OPTIONS,
} from "../../shared/live-call";
import { DEFAULT_DEEPSEEK_VOICE, DEEPSEEK_VOICES } from "../../shared/deepseek-voice";
import { DEFAULT_OPENAI_VOICE, OPENAI_VOICES } from "../../shared/openai-voice";
import {
  CALL_LANGUAGE_AUTO,
  CALL_LANGUAGES,
  CALL_SPEED_DEFAULT,
  CALL_SPEED_STEP,
  callSpeedFor,
  callVoiceCapability,
  roundCallSpeed,
  type CallSpeedSupport,
  type CallVoiceTarget,
} from "../../shared/call-voice";
import type { ActiveCall } from "@/lib/call-session";
import { liveCallProvider, turnsCallProvider } from "@/lib/call-provider";
import { playVoicePreview, stopVoicePreview, useVoicePreview, voicePreviewKey } from "@/lib/call-voice-preview";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { listLocalSystemVoices, remoteSystemVoice, setRemoteSystemVoice } from "@/lib/local-voice";
import { useLiveMedia } from "@/lib/live-call-media";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import { api, useStore, type Bot } from "@/state/store";
import { Select } from "./Select";
import { VoicePicker, type PickerVoice } from "./VoicePicker";

interface VoiceChoice {
  id: string;
  label: string;
}

const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

function providerLabel(target: CallVoiceTarget): string {
  if (target.mode === "live") return t(`call.live.provider.${target.provider}`);
  switch (target.provider) {
    case "elevenlabs": return t("voice.elevenlabs.label");
    case "fish": return t("voice.fish.label");
    case "chatterbox": return t("voice.chatterboxLabel");
    case "xai": return t("voice.grok.label");
    case "openai": return t("call.live.provider.openai");
    case "gemini": return "Gemini";
    case "deepseek": return "DeepSeek";
    case "device": return t("call.voice.thisComputer");
    default: return t("call.voice.thisComputer");
  }
}

function noSpeedReason(reason: "own-pace" | "custom-server" | "codex"): string {
  return t(reason === "own-pace" ? "call.voice.noSpeed.ownPace" : reason === "custom-server" ? "call.voice.noSpeed.customServer" : "call.voice.noSpeed.codex");
}

function SpeedRow({ speed, saved, onSave }: { speed: CallSpeedSupport; saved: number | undefined; onSave: (value: number) => void }) {
  const current = speed.kind === "none" ? CALL_SPEED_DEFAULT : callSpeedFor(saved, speed);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const commit = () => {
    if (speed.kind !== "none" && draft !== current) onSave(draft);
  };
  return (
    <section aria-label={t("call.voice.speed")} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="call-voice-speed" className="font-medium text-ink">{t("call.voice.speed")}</label>
        <span className="tabular-nums text-ink-secondary">{t("call.voice.speedValue", { value: String(draft) })}</span>
      </div>
      {speed.kind === "none" ? (
        <>
          <input id="call-voice-speed" type="range" disabled min={0.5} max={2} step={CALL_SPEED_STEP} value={CALL_SPEED_DEFAULT} className="w-full accent-accent" aria-describedby="call-voice-speed-note" />
          <p id="call-voice-speed-note" className="text-[12px] leading-4 text-ink-tertiary">{noSpeedReason(speed.reason)}</p>
        </>
      ) : (
        <>
          <input
            id="call-voice-speed"
            type="range"
            min={speed.min}
            max={speed.max}
            step={CALL_SPEED_STEP}
            value={draft}
            onChange={(event) => setDraft(roundCallSpeed(Number(event.target.value)))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="w-full accent-accent"
          />
          <div className="flex items-center justify-between gap-2 text-[12px] leading-4 text-ink-tertiary">
            <span>{t(speed.applies === "next-reply" ? "call.voice.appliesReply" : "call.voice.appliesCall")}</span>
            {current !== CALL_SPEED_DEFAULT && (
              <button type="button" className="text-accent hover:underline" onClick={() => onSave(CALL_SPEED_DEFAULT)}>{t("call.voice.speedReset")}</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function SampleButton({ label, playing, onPlay }: { label: string; playing: boolean; onPlay: () => void }) {
  return (
    <button
      type="button"
      aria-label={playing ? t("call.voice.stopSample") : t("call.voice.playSample", { voice: label })}
      onClick={() => (playing ? stopVoicePreview() : onPlay())}
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {playing ? <Square size={12} /> : <Play size={12} />}
    </button>
  );
}

function cardChoices(target: CallVoiceTarget, config: ReturnType<typeof useStore>["state"]["config"]): { choices: VoiceChoice[]; current: (bot: Bot) => string } {
  if (target.mode === "live") {
    const gemini = target.provider === "gemini";
    const appVoice = gemini ? geminiLiveVoice(config?.live?.geminiVoice) : config?.live?.voice || "marin";
    return {
      choices: [...(gemini ? GEMINI_LIVE_VOICE_OPTIONS : LIVE_VOICE_OPTIONS)],
      current: (bot) => botCallVoice(bot.liveVoice, appVoice, gemini) ?? appVoice,
    };
  }
  if (target.provider === "deepseek") {
    return {
      choices: DEEPSEEK_VOICES.map((id) => ({ id, label: t(`voice.deepseek.${id}`) })),
      current: (bot) => (DEEPSEEK_VOICES as readonly string[]).includes(bot.voice ?? "") ? bot.voice! : DEFAULT_DEEPSEEK_VOICE,
    };
  }
  return {
    choices: OPENAI_VOICES.map((id) => ({ id, label: title(id) })),
    current: (bot) => (OPENAI_VOICES as readonly string[]).includes(bot.voice ?? "") ? bot.voice! : DEFAULT_OPENAI_VOICE,
  };
}

export function CallVoicePanel({ bot, call }: { bot: Bot; call: Pick<ActiveCall, "mode"> }) {
  const { state, dispatch } = useStore();
  const media = useLiveMedia();
  const preview = useVoicePreview();
  const target = useMemo<CallVoiceTarget>(
    () => call.mode === "live"
      ? { mode: "live", provider: liveCallProvider(state.config, media.provider) }
      : { mode: "turns", provider: turnsCallProvider(state.config) },
    [call.mode, media.provider, state.config],
  );
  const capability = callVoiceCapability(target);
  const live = target.mode === "live";
  const save = (patch: BotUpdatePatch) => dispatch({ type: "updateBot", botId: bot.id, patch });
  const speedNow = capability.speed.kind === "none" ? undefined : callSpeedFor(bot.callSpeed, capability.speed);
  const language = bot.callLanguage && bot.callLanguage !== CALL_LANGUAGE_AUTO ? bot.callLanguage : undefined;
  const sample = (voice: string) => void playVoicePreview({ target, voice, text: t("call.voice.sample"), speed: speedNow, language });

  const [query, setQuery] = useState("");
  const [voices, setVoices] = useState<PickerVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<PickerVoice | undefined>();
  const [, refreshDevice] = useState(0);
  const listed = capability.voicePicker === "search" || (capability.voicePicker === "cards" && !live && target.provider === "gemini");
  const searchTerm = capability.voicePicker === "search" ? query.trim() : "";

  useEffect(() => {
    if (!listed) return;
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams();
    if (searchTerm) params.set("q", searchTerm);
    const text = params.toString();
    api<{ voices?: PickerVoice[] }>(`/api/tts/voices${text ? `?${text}` : ""}`)
      .then((body) => alive && setVoices(body.voices ?? []))
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [listed, searchTerm]);

  const pickSearched = (voice: PickerVoice) => {
    if (!voice.publicOwnerId) return save({ voice: voice.id });
    setAdding(voice);
    api<{ voiceId: string }>("/api/tts/voices/add", {
      method: "POST",
      body: JSON.stringify({ publicOwnerId: voice.publicOwnerId, voiceId: voice.id, name: voice.label }),
    })
      .then((added) => save({ voice: added.voiceId }))
      .catch(() => undefined)
      .finally(() => setAdding(undefined));
  };

  const cards = capability.voicePicker === "cards"
    ? (live || target.provider !== "gemini" ? cardChoices(target, state.config) : null)
    : null;
  const geminiCards: VoiceChoice[] = voices.map((voice) => ({ id: voice.id, label: voice.label }));
  const choices = cards?.choices ?? (capability.voicePicker === "cards" ? geminiCards : []);
  const currentCard = cards ? cards.current(bot) : (bot.voice ?? "");
  const pickCard = (id: string) => save(live ? { liveVoice: id } : { voice: id });

  const deviceVoices = capability.voicePicker === "device" ? listLocalSystemVoices() : [];
  const deviceVoice = remoteSystemVoice(bot.id);

  const searchedVoice = bot.voice ?? "";
  const playing = (voice: string) => preview.playing === voicePreviewKey(target, voice);
  const sampleShown = (voice: string) => !preview.unavailable.has(voicePreviewKey(target, voice));

  return (
    <div role="dialog" aria-label={t("call.voice.title")} className="popover-surface flex max-h-[70vh] w-80 max-w-[90vw] flex-col gap-4 overflow-y-auto rounded-xl border border-hairline/50 bg-menu p-3 text-[13px] leading-5 text-ink shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-medium">{t("call.voice.title")}</h2>
        <span className="truncate rounded-full bg-raised px-2 py-0.5 text-[12px] text-ink-secondary">
          {t("call.voice.chip", { provider: providerLabel(target), mode: t(live ? "call.mode.live" : "call.mode.turns") })}
        </span>
      </div>

      <SpeedRow speed={capability.speed} saved={bot.callSpeed} onSave={(value) => save({ callSpeed: value })} />

      <section aria-label={t("call.voice.voice")} className="flex flex-col gap-1.5">
        <div className="font-medium">{t("call.voice.voice")}</div>
        {capability.voicePicker === "agent" && (
          <p className="text-ink-secondary">{t("call.voice.agentVoice", { provider: providerLabel(target) })}</p>
        )}
        {capability.voicePicker === "fixed" && <p className="text-ink-secondary">{t("call.voice.fixedVoice")}</p>}
        {capability.voicePicker === "cards" && (
          <div role="radiogroup" aria-label={t("call.voice.voice")} className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
            {loading && choices.length === 0 && <Loader2 size={14} aria-hidden className="animate-spin text-ink-secondary" />}
            {choices.map((choice) => (
              <div key={choice.id} className="flex items-center gap-1">
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice.id === currentCard}
                  onClick={() => pickCard(choice.id)}
                  className={cn(
                    "min-w-0 flex-1 truncate rounded-lg border px-2.5 py-1.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    choice.id === currentCard ? "border-accent bg-raised font-medium" : "border-hairline/40 hover:bg-raised",
                  )}
                >
                  {choice.label}
                </button>
                {sampleShown(choice.id) && <SampleButton label={choice.label} playing={playing(choice.id)} onPlay={() => sample(choice.id)} />}
              </div>
            ))}
          </div>
        )}
        {capability.voicePicker === "search" && (
          <div className="flex items-center gap-1">
            <VoicePicker
              value={searchedVoice}
              voices={voices}
              loading={loading}
              query={query}
              onQuery={setQuery}
              onPick={pickSearched}
              pending={adding}
              defaultLabel={t("voice.current")}
              ariaLabel={t("call.voice.voice")}
            />
            {searchedVoice && sampleShown(searchedVoice) && (
              <SampleButton label={voices.find((voice) => voice.id === searchedVoice)?.label ?? t("voice.current")} playing={playing(searchedVoice)} onPlay={() => sample(searchedVoice)} />
            )}
          </div>
        )}
        {capability.voicePicker === "device" && (
          <div className="flex items-center gap-1">
            <Select
              size="sm"
              aria-label={t("call.voice.device")}
              value={deviceVoice}
              onChange={(event) => {
                setRemoteSystemVoice(bot.id, event.target.value);
                refreshDevice((version) => version + 1);
              }}
            >
              <option value="">{t("call.voice.deviceDefault")}</option>
              {deviceVoices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
            </Select>
            <SampleButton label={t("call.voice.device")} playing={playing(deviceVoice)} onPlay={() => sample(deviceVoice)} />
          </div>
        )}
        {capability.voiceApplies === "next-call" && capability.voicePicker !== "fixed" && (
          <p className="text-[12px] leading-4 text-ink-tertiary">{t("call.voice.nextCall")}</p>
        )}
      </section>

      {!(live && capability.language === "none") && (
        <section aria-label={t("call.voice.language")} className="flex items-center justify-between gap-2">
          <label htmlFor="call-voice-language" className="font-medium">{t("call.voice.language")}</label>
          <Select
            id="call-voice-language"
            size="sm"
            value={bot.callLanguage ?? CALL_LANGUAGE_AUTO}
            onChange={(event) => save({ callLanguage: event.target.value })}
          >
            <option value={CALL_LANGUAGE_AUTO}>{t("call.voice.languageAuto")}</option>
            {CALL_LANGUAGES.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
          </Select>
        </section>
      )}
    </div>
  );
}
