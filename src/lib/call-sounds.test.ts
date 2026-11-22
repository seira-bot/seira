// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setNotificationSounds } from "./notification-preferences";
import { callTonesAllowed, playHangup, playPickup, resetCallSounds, RING_CYCLE_MS, RING_PHRASE_MS, startRing } from "./call-sounds";

interface Param { value: number; setValueAtTime(): void; linearRampToValueAtTime(): void; exponentialRampToValueAtTime(): void }
const param = (): Param => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });

const made = { contexts: 0, oscillators: [] as Array<{ hz: number; at: number }>, delays: [] as number[], lowpass: [] as number[], feedback: [] as number[] };

class FakeContext {
  currentTime = 0;
  state = "running";
  destination = {};
  constructor() { made.contexts += 1; }
  resume = async () => undefined;
  close = async () => undefined;
  createGain() {
    const node = { gain: param(), connect() {} };
    return node;
  }
  createBiquadFilter() {
    const node = { type: "", frequency: { set value(v: number) { made.lowpass.push(v); } }, connect() {} };
    return node;
  }
  createDelay() {
    return { delayTime: { set value(v: number) { made.delays.push(v); } }, connect() {} };
  }
  createOscillator() {
    const osc = { type: "", frequency: { value: 0 }, start: (at: number) => made.oscillators.push({ hz: osc.frequency.value, at }), stop() {}, connect() {} };
    return osc;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  made.contexts = 0;
  made.oscillators = [];
  made.delays = [];
  made.lowpass = [];
  vi.stubGlobal("AudioContext", FakeContext);
  setNotificationSounds(true);
});
afterEach(() => {
  resetCallSounds();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fundamentals = () => made.oscillators.filter((_, index) => index % 4 === 0).map((note) => Math.round(note.hz * 100) / 100);

describe("call sounds", () => {
  it("rings an Emaj7 arpeggio with a softer echo, through a 0.19 s delay and a 3600 Hz lowpass", () => {
    const ring = startRing();
    expect(fundamentals()).toEqual([659.25, 830.61, 987.77, 1244.51, 1244.51, 987.77]);
    expect(made.delays).toEqual([0.19]);
    expect(made.lowpass).toEqual([3600]);
    void ring.stop();
  });

  it("builds each note from partials at 1, 2, 3 and 4.01 times the pitch", () => {
    startRing();
    expect(made.oscillators.slice(0, 4).map((note) => Math.round(note.hz * 100) / 100)).toEqual([659.25, 1318.5, 1977.75, 2643.59]);
  });

  it("repeats the phrase every 2.8 seconds until it stops", () => {
    const ring = startRing();
    const first = made.oscillators.length;
    vi.advanceTimersByTime(RING_CYCLE_MS);
    expect(made.oscillators.length).toBe(first * 2);
    void ring.stop();
    vi.advanceTimersByTime(RING_CYCLE_MS * 3);
    expect(made.oscillators.length).toBe(first * 2);
  });

  it("lets the phrase that is sounding finish before stop resolves", async () => {
    const ring = startRing();
    vi.advanceTimersByTime(500);
    let done = false;
    void ring.stop().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(RING_PHRASE_MS - 501);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it("resolves at once when stop comes in the silent part of the cycle", async () => {
    const ring = startRing();
    vi.advanceTimersByTime(RING_PHRASE_MS + 100);
    let done = false;
    void ring.stop().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it("plays the pick-up as 987.77 then 1318.51 Hz and the hang-up as 987.77 then 659.25 Hz", () => {
    playPickup();
    expect(fundamentals()).toEqual([987.77, 1318.51]);
    made.oscillators = [];
    playHangup();
    expect(fundamentals()).toEqual([987.77, 659.25]);
  });

  it("makes one shared audio context", () => {
    startRing();
    playPickup();
    playHangup();
    expect(made.contexts).toBe(1);
  });

  it("plays nothing while notification sounds are off", async () => {
    setNotificationSounds(false);
    const ring = startRing();
    playPickup();
    playHangup();
    await ring.stop();
    expect(made.oscillators).toEqual([]);
    expect(made.contexts).toBe(0);
    expect(callTonesAllowed()).toBe(false);
  });

  it("plays nothing while the call reconnects", () => {
    startRing({ reconnecting: true });
    playPickup({ reconnecting: true });
    playHangup({ reconnecting: true });
    expect(made.oscillators).toEqual([]);
    expect(callTonesAllowed(true)).toBe(false);
  });

  it("stays quiet when the browser has no audio context", async () => {
    vi.stubGlobal("AudioContext", undefined);
    await startRing().stop();
    playPickup();
    expect(made.oscillators).toEqual([]);
  });
});
