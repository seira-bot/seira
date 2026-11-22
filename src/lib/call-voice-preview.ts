import { useSyncExternalStore } from "react";

import {
  CALL_VOICE_PREVIEW_TEXT_MAX,
  callLanguage,
  callSpeedFor,
  callVoiceCapability,
  roundCallSpeed,
  type CallVoicePreviewRequest,
} from "../../shared/call-voice";
import type { LiveProvider } from "../../packages/phone-protocol/src/live-call-wire";
import type { TurnsVoiceProvider } from "../../shared/call-voice";
import { callPlaybackRate, callRequestFields } from "./tts";
import { resolveLocalSystemVoice } from "./local-voice";

export type VoicePreviewTarget = { mode: "live"; provider: LiveProvider } | { mode: "turns"; provider: TurnsVoiceProvider };

export interface VoicePreviewRequest {
  target: VoicePreviewTarget;
  voice: string;
  text: string;
  speed?: number;
  language?: string;
}

interface PreviewState {
  playing: string | null;
  unavailable: ReadonlySet<string>;
}

let state: PreviewState = { playing: null, unavailable: new Set() };
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let utterance: SpeechSynthesisUtterance | null = null;
let abort: AbortController | null = null;
let generation = 0;
const watchers = new Set<() => void>();

function commit(next: PreviewState): void {
  state = next;
  for (const watcher of Array.from(watchers)) watcher();
}

export const voicePreviewKey = (target: VoicePreviewTarget, voice: string) => `${target.mode}:${target.provider}:${voice}`;

function teardown(): void {
  generation += 1;
  abort?.abort();
  abort = null;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio = null;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (utterance) {
    utterance.onend = null;
    utterance.onerror = null;
    utterance = null;
    window.speechSynthesis?.cancel();
  }
}

/** Stops the sample that is sounding, if any. */
export function stopVoicePreview(): void {
  teardown();
  if (state.playing !== null) commit({ ...state, playing: null });
}

async function fetchSample(request: VoicePreviewRequest, signal: AbortSignal): Promise<Response> {
  const { target, voice, text } = request;
  if (target.mode === "live") {
    const body: CallVoicePreviewRequest = {
      provider: target.provider,
      voice,
      text: text.slice(0, CALL_VOICE_PREVIEW_TEXT_MAX),
      ...(request.speed !== undefined ? { speed: roundCallSpeed(request.speed) } : {}),
    };
    return fetch("/api/call/voice-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  }
  const call = { provider: target.provider, speed: request.speed, language: request.language };
  return fetch("/api/tts/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voiceId: voice, ...callRequestFields(call) }),
    signal,
  });
}

function playDevice(request: VoicePreviewRequest, mine: number): void {
  const synth = window.speechSynthesis;
  const spoken = new SpeechSynthesisUtterance(request.text);
  const chosen = resolveLocalSystemVoice(request.voice);
  if (chosen) spoken.voice = chosen;
  spoken.rate = callSpeedFor(request.speed, callVoiceCapability({ mode: "turns", provider: "device" }).speed);
  const language = callLanguage(request.language);
  if (language) spoken.lang = language.code;
  const done = () => {
    if (mine === generation) stopVoicePreview();
  };
  spoken.onend = done;
  spoken.onerror = done;
  utterance = spoken;
  synth.speak(spoken);
}

/** Plays one sample at the chosen speed and stops any other. Resolves false when the provider cannot speak this voice outside a call. */
export async function playVoicePreview(request: VoicePreviewRequest): Promise<boolean> {
  teardown();
  const key = voicePreviewKey(request.target, request.voice);
  const mine = generation;
  commit({ ...state, playing: key });
  if (request.target.mode === "turns" && request.target.provider === "device") {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      commit({ ...state, playing: null });
      return false;
    }
    playDevice(request, mine);
    return true;
  }
  const controller = new AbortController();
  abort = controller;
  try {
    const res = await fetchSample(request, controller.signal);
    if (mine !== generation) return true;
    if (res.status === 404) {
      commit({ playing: null, unavailable: new Set([...state.unavailable, key]) });
      return false;
    }
    if (!res.ok) {
      commit({ ...state, playing: null });
      return false;
    }
    const blob = await res.blob();
    if (mine !== generation) return true;
    const url = URL.createObjectURL(blob);
    const sample = new Audio(url);
    if (request.target.mode === "turns") {
      const rate = callPlaybackRate({ provider: request.target.provider, speed: request.speed, language: request.language });
      if (rate !== undefined) {
        sample.playbackRate = rate;
        sample.preservesPitch = true;
      }
    }
    audio = sample;
    objectUrl = url;
    const finished = () => {
      if (mine === generation) stopVoicePreview();
    };
    sample.onended = finished;
    sample.onerror = finished;
    await sample.play().catch(finished);
    return true;
  } catch {
    if (mine === generation) commit({ ...state, playing: null });
    return mine !== generation;
  }
}

export function resetVoicePreview(): void {
  teardown();
  commit({ playing: null, unavailable: new Set() });
}

const subscribe = (watcher: () => void) => {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
};
const snapshot = () => state;

export const voicePreviewState = snapshot;

export function useVoicePreview(): PreviewState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
