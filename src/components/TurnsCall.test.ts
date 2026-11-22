// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";
import { atlas, turnsConfig } from "./call-test-support";

const fixture = vi.hoisted(() => ({ config: null as unknown, tones: false, bridge: null as unknown, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config as AppState["config"], bots: [] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/speech", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/speech")>()), speechBridge: () => fixture.bridge }));
vi.mock("@/lib/push-to-talk", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/push-to-talk")>()), usePushToTalk: () => false }));
vi.mock("@/lib/call-sounds", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/call-sounds")>()), callTonesAllowed: () => fixture.tones }));
const speak = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/tts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tts")>();
  return { ...original, speaker: { speak, stop: vi.fn(), isSpeaking: () => false } };
});

const { TurnsCall } = await import("./TurnsCall");
const { startCall, endCall } = await import("@/lib/call");
const { callSession, muteActiveCall, resetCallSession } = await import("@/lib/call-session");
const { RING_PHRASE_MS } = await import("@/lib/call-sounds");

let root: Root;
let host: HTMLDivElement;
let speechStart: ReturnType<typeof vi.fn>;
let speechStop: ReturnType<typeof vi.fn>;
let onTranscript: ((line: { text?: string; partial?: boolean; error?: boolean }) => void) | null;

const mount = (bot = atlas) => act(() => root.render(createElement(TurnsCall, { bot })));

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.config = turnsConfig("openai");
  fixture.tones = false;
  onTranscript = null;
  speechStart = vi.fn(async () => undefined);
  speechStop = vi.fn(async () => undefined);
  fixture.bridge = {
    speechStart,
    speechStop,
    onSpeechTranscript: (handler: typeof onTranscript) => { onTranscript = handler; return () => undefined; },
    onSpeechEnd: () => () => undefined,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  speak.mockClear();
  startCall("atlas");
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  endCall();
  resetCallSession();
  vi.useRealTimers();
});

describe("TurnsCall", () => {
  it("rings, then connects after the phrase, and only then opens the microphone", () => {
    fixture.tones = true;
    mount();
    expect(callSession()).toMatchObject({ botId: "atlas", stage: "calling" });
    act(() => { vi.advanceTimersByTime(RING_PHRASE_MS - 1); });
    expect(speechStart).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(callSession().stage).toBe("connected");
    expect(callSession().startedAt).not.toBeNull();
    expect(speechStart).toHaveBeenCalledOnce();
  });

  it("connects after a short quiet moment while sounds are off", () => {
    mount();
    act(() => { vi.advanceTimersByTime(800); });
    expect(callSession().stage).toBe("connected");
  });

  it("dictates in the chosen call language, and leaves the language out for auto", () => {
    mount({ ...atlas, callLanguage: "id" });
    act(() => { vi.advanceTimersByTime(800); });
    expect(speechStart).toHaveBeenLastCalledWith(expect.objectContaining({ locale: "id" }));
    act(() => root.unmount());
    root = createRoot(host);
    speechStart.mockClear();
    resetCallSession();
    mount({ ...atlas, callLanguage: "auto" });
    act(() => { vi.advanceTimersByTime(800); });
    expect(speechStart.mock.calls.at(-1)![0]).not.toHaveProperty("locale");
  });

  it("closes the microphone while muted and opens it again when unmuted", () => {
    mount();
    act(() => { vi.advanceTimersByTime(800); });
    speechStart.mockClear();
    speechStop.mockClear();
    act(() => muteActiveCall({ mode: "turns" }, true));
    expect(speechStop).toHaveBeenCalled();
    expect(speechStart).not.toHaveBeenCalled();
    act(() => muteActiveCall({ mode: "turns" }, false));
    expect(speechStart).toHaveBeenCalledOnce();
  });

  it("adds what the person said to the captions", () => {
    mount();
    act(() => { vi.advanceTimersByTime(800); });
    act(() => onTranscript?.({ text: "hello there", partial: false }));
    expect(callSession().captions.map((line) => `${line.who}:${line.text}`)).toEqual(["you:hello there"]);
  });
});
