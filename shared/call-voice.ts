import type { LiveProvider } from "../packages/phone-protocol/src/live-call-wire.ts";

/** The Turns voice providers as stored in `tts.provider`, plus `device`: the speech voices of the computer that shows the call. */
export type TurnsVoiceProvider = "elevenlabs" | "fish" | "system" | "chatterbox" | "xai" | "gemini" | "openai" | "deepseek" | "device";

export type CallVoiceTarget = { mode: "live"; provider: LiveProvider } | { mode: "turns"; provider: TurnsVoiceProvider };

/** When a change reaches the voice the person hears. */
export type CallApplies = "next-reply" | "next-call";

/**
 * `native`: the provider takes a speed. `playback`: the provider has none, so the app plays the
 * reply faster or slower and keeps the pitch. `none`: the row shows disabled with its reason.
 */
export type CallSpeedSupport =
  | { kind: "native"; min: number; max: number; applies: CallApplies }
  | { kind: "playback"; min: number; max: number; applies: "next-reply" }
  | { kind: "none"; reason: "own-pace" | "custom-server" | "codex" };

/**
 * `cards`: a short fixed list. `search`: an account or library list with search and preview.
 * `agent`: the voice belongs to the provider's call agent. `fixed`: one voice, no choice.
 * `device`: the computer's own speech voices.
 */
export type CallVoicePicker = "cards" | "search" | "agent" | "fixed" | "device";

/** `native`: the provider takes a language. `instruction`: the call instructions name it. `none`: the reply text decides. */
export type CallLanguageSupport = "native" | "instruction" | "none";

export interface CallVoiceCapability {
  speed: CallSpeedSupport;
  voicePicker: CallVoicePicker;
  voiceApplies: CallApplies;
  language: CallLanguageSupport;
}

export const CALL_SPEED_MIN = 0.5;
export const CALL_SPEED_MAX = 2;
export const CALL_SPEED_DEFAULT = 1;
export const CALL_SPEED_STEP = 0.05;

const native = (min: number, max: number, applies: CallApplies): CallSpeedSupport => ({ kind: "native", min, max, applies });
const playback: CallSpeedSupport = { kind: "playback", min: 0.75, max: 1.5, applies: "next-reply" };

// Ranges from the provider references (checked 2026-11-22): OpenAI Realtime audio.output.speed 0.25–1.5,
// ElevenLabs voice_settings.speed and agent tts.speed 0.7–1.2, Fish prosody.speed and agent voice.speed 0.5–2.0,
// xAI speed 0.7–1.5, Web Speech rate 0.1–10. Below 0.75 OpenAI speech is hard to follow, so the slider stops there.
const LIVE: Record<LiveProvider, CallVoiceCapability> = {
  openai: { speed: native(0.75, 1.5, "next-reply"), voicePicker: "cards", voiceApplies: "next-call", language: "instruction" },
  azure: { speed: native(0.75, 1.5, "next-reply"), voicePicker: "cards", voiceApplies: "next-call", language: "instruction" },
  custom: { speed: { kind: "none", reason: "custom-server" }, voicePicker: "cards", voiceApplies: "next-call", language: "instruction" },
  elevenlabs: { speed: native(0.7, 1.2, "next-call"), voicePicker: "agent", voiceApplies: "next-call", language: "native" },
  fish: { speed: native(0.5, 2, "next-call"), voicePicker: "agent", voiceApplies: "next-call", language: "native" },
  gemini: { speed: { kind: "none", reason: "own-pace" }, voicePicker: "cards", voiceApplies: "next-call", language: "instruction" },
  codex: { speed: { kind: "none", reason: "codex" }, voicePicker: "fixed", voiceApplies: "next-call", language: "none" },
};

const TURNS: Record<TurnsVoiceProvider, CallVoiceCapability> = {
  openai: { speed: native(0.75, 1.5, "next-reply"), voicePicker: "cards", voiceApplies: "next-reply", language: "none" },
  elevenlabs: { speed: native(0.7, 1.2, "next-reply"), voicePicker: "search", voiceApplies: "next-reply", language: "native" },
  fish: { speed: native(0.5, 2, "next-reply"), voicePicker: "search", voiceApplies: "next-reply", language: "none" },
  xai: { speed: native(0.7, 1.5, "next-reply"), voicePicker: "search", voiceApplies: "next-reply", language: "native" },
  gemini: { speed: playback, voicePicker: "cards", voiceApplies: "next-reply", language: "none" },
  deepseek: { speed: playback, voicePicker: "cards", voiceApplies: "next-reply", language: "none" },
  chatterbox: { speed: playback, voicePicker: "search", voiceApplies: "next-reply", language: "none" },
  system: { speed: playback, voicePicker: "search", voiceApplies: "next-reply", language: "none" },
  device: { speed: native(0.5, 2, "next-reply"), voicePicker: "device", voiceApplies: "next-reply", language: "native" },
};

export function callVoiceCapability(target: CallVoiceTarget): CallVoiceCapability {
  return target.mode === "live" ? LIVE[target.provider] : TURNS[target.provider];
}

/** A bot's saved speed is any value in 0.5–2.0; each provider then clamps it to its own range. */
export function isCallSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= CALL_SPEED_MIN && value <= CALL_SPEED_MAX;
}

/** The speed to send or play: the saved speed clamped to the provider's range, rounded to the slider step; 1 when the provider has no speed. */
export function callSpeedFor(saved: number | undefined, speed: CallSpeedSupport): number {
  if (speed.kind === "none") return CALL_SPEED_DEFAULT;
  const value = isCallSpeed(saved) ? saved : CALL_SPEED_DEFAULT;
  const clamped = Math.min(speed.max, Math.max(speed.min, value));
  return Number((Math.round(clamped / CALL_SPEED_STEP) * CALL_SPEED_STEP).toFixed(2));
}

export interface CallLanguage {
  /** BCP-47 tag. */
  code: string;
  /** The language's name in itself, shown in the picker without translation. */
  label: string;
  /** English name, for the line that the call instructions carry. */
  english: string;
}

export const CALL_LANGUAGE_AUTO = "auto";

export const CALL_LANGUAGES: readonly CallLanguage[] = [
  { code: "en", label: "English", english: "English" },
  { code: "id", label: "Bahasa Indonesia", english: "Indonesian" },
  { code: "ms", label: "Bahasa Melayu", english: "Malay" },
  { code: "jv", label: "Basa Jawa", english: "Javanese" },
  { code: "es", label: "Español", english: "Spanish" },
  { code: "pt-BR", label: "Português (Brasil)", english: "Brazilian Portuguese" },
  { code: "fr", label: "Français", english: "French" },
  { code: "de", label: "Deutsch", english: "German" },
  { code: "it", label: "Italiano", english: "Italian" },
  { code: "nl", label: "Nederlands", english: "Dutch" },
  { code: "tr", label: "Türkçe", english: "Turkish" },
  { code: "ru", label: "Русский", english: "Russian" },
  { code: "ar", label: "العربية", english: "Arabic" },
  { code: "hi", label: "हिन्दी", english: "Hindi" },
  { code: "th", label: "ไทย", english: "Thai" },
  { code: "vi", label: "Tiếng Việt", english: "Vietnamese" },
  { code: "zh", label: "中文", english: "Chinese" },
  { code: "ja", label: "日本語", english: "Japanese" },
  { code: "ko", label: "한국어", english: "Korean" },
];

/** Absent or `auto`: the call follows the conversation. */
export function isCallLanguage(value: unknown): value is string {
  return value === CALL_LANGUAGE_AUTO || CALL_LANGUAGES.some((language) => language.code === value);
}

/** The chosen language, or undefined for auto or an unknown code. */
export function callLanguage(saved: string | undefined): CallLanguage | undefined {
  return CALL_LANGUAGES.find((language) => language.code === saved);
}

/** The ISO 639-1 part of a tag, for providers that take only that (ElevenLabs `language_code`, agent language). */
export function callLanguageBase(language: CallLanguage): string {
  return language.code.split("-")[0];
}

/** The line a provider without a language field gets in its call instructions; undefined for auto. */
export function callLanguageInstruction(saved: string | undefined): string | undefined {
  const language = callLanguage(saved);
  return language ? `Speak ${language.english} for the whole call, even when the person uses another language.` : undefined;
}

export const CALL_VOICE_PREVIEW_TEXT_MAX = 200;

/**
 * Body of a Live voice sample request. The server answers with audio, or 404 when it cannot
 * speak that voice outside a call; the client then hides the play button for that voice.
 */
export interface CallVoicePreviewRequest {
  provider: LiveProvider;
  voice: string;
  /** The sample sentence in the app language, at most `CALL_VOICE_PREVIEW_TEXT_MAX` characters. */
  text: string;
  /** 0.5–2.0; the server clamps it to the provider range. Absent: 1. */
  speed?: number;
}

/** A slider value trimmed to two decimals, so 1.1500000000000001 is saved as 1.15. */
export function roundCallSpeed(value: number): number {
  return Math.round(value * 100) / 100;
}
