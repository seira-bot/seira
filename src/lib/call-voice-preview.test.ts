// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playVoicePreview, resetVoicePreview, voicePreviewKey, voicePreviewState } from "./call-voice-preview";

const audios: Array<{ src: string; playbackRate: number; preservesPitch: boolean; paused: boolean; play: () => Promise<void>; pause: () => void; onended: (() => void) | null; onerror: (() => void) | null }> = [];

class FakeAudio {
  playbackRate = 1;
  preservesPitch = false;
  paused = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public src: string) { audios.push(this); }
  play = async () => undefined;
  pause = () => { this.paused = true; };
}

const fetchMock = vi.fn();

beforeEach(() => {
  audios.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(new Blob(["x"]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", FakeAudio);
  URL.createObjectURL = () => "blob:sample";
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  resetVoicePreview();
  vi.unstubAllGlobals();
});

describe("voice samples", () => {
  it("asks a Live provider for a sample with the chosen speed", async () => {
    expect(await playVoicePreview({ target: { mode: "live", provider: "openai" }, voice: "marin", text: "Hello", speed: 1.15 })).toBe(true);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/call/voice-preview");
    expect(JSON.parse(init.body)).toEqual({ provider: "openai", voice: "marin", text: "Hello", speed: 1.15 });
  });

  it("hides the sample of a voice the provider cannot speak outside a call", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    const target = { mode: "live", provider: "elevenlabs" } as const;
    expect(await playVoicePreview({ target, voice: "v1", text: "Hello" })).toBe(false);
    expect(voicePreviewState().unavailable.has(voicePreviewKey(target, "v1"))).toBe(true);
    expect(voicePreviewState().playing).toBeNull();
  });

  it("plays a Turns sample faster for a provider with no speed field and keeps the pitch", async () => {
    await playVoicePreview({ target: { mode: "turns", provider: "gemini" }, voice: "Puck", text: "Hello", speed: 1.25 });
    expect(audios).toHaveLength(1);
    expect(audios[0]).toMatchObject({ playbackRate: 1.25, preservesPitch: true });
  });

  it("leaves the rate alone for a provider that takes a speed", async () => {
    await playVoicePreview({ target: { mode: "turns", provider: "openai" }, voice: "marin", text: "Hello", speed: 1.25 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ speed: 1.25 });
    expect(audios[0]?.playbackRate).toBe(1);
  });

  it("stops the sample that is sounding when another starts", async () => {
    await playVoicePreview({ target: { mode: "live", provider: "openai" }, voice: "marin", text: "One" });
    const first = audios[0]!;
    await playVoicePreview({ target: { mode: "live", provider: "openai" }, voice: "cedar", text: "Two" });
    expect(first.paused).toBe(true);
    expect(audios).toHaveLength(2);
    expect(audios[1]?.paused).toBe(false);
  });

  it("speaks a device sample with the chosen rate and language", async () => {
    const spoken: Array<{ rate: number; lang: string }> = [];
    vi.stubGlobal("SpeechSynthesisUtterance", class { rate = 1; lang = ""; voice = null; onend = null; onerror = null; constructor(public text: string) { spoken.push(this); } });
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] });
    expect(await playVoicePreview({ target: { mode: "turns", provider: "device" }, voice: "", text: "Hello", speed: 1.5, language: "id" })).toBe(true);
    expect(spoken[0]).toMatchObject({ rate: 1.5, lang: "id" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
