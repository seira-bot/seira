import { notificationSoundsEnabled } from "./notification-preferences";

const PARTIALS = [1, 2, 3, 4.01] as const;
const PARTIAL_GAIN = [1, 0.45, 0.22, 0.1] as const;
const ARPEGGIO = [659.25, 830.61, 987.77, 1244.51] as const;
const ARPEGGIO_STEP_S = 0.11;
const ECHO = [{ hz: 1244.51, at: 0.62, gain: 0.35 }, { hz: 987.77, at: 0.73, gain: 0.28 }] as const;
const PICKUP = [987.77, 1318.51] as const;
const HANGUP = [987.77, 659.25] as const;
const NOTE_STEP_S = 0.11;
const NOTE_DECAY_S = 0.9;
const ECHO_DELAY_S = 0.19;
const ECHO_FEEDBACK = 0.32;
const LOWPASS_HZ = 3600;
const MASTER_GAIN = 0.16;

export const RING_CYCLE_MS = 2800;
/** From the first note to the end of the echo's ring: the part of a cycle that is not silence. */
export const RING_PHRASE_MS = 1700;

interface Bus {
  context: AudioContext;
  input: GainNode;
}

let bus: Bus | null = null;

function ensureBus(): Bus | null {
  if (bus) {
    if (bus.context.state === "suspended") void bus.context.resume().catch(() => undefined);
    return bus;
  }
  const Context = globalThis.AudioContext;
  if (typeof Context !== "function") return null;
  try {
    const context = new Context();
    const input = context.createGain();
    input.gain.value = MASTER_GAIN;
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = LOWPASS_HZ;
    const delay = context.createDelay(1);
    delay.delayTime.value = ECHO_DELAY_S;
    const feedback = context.createGain();
    feedback.gain.value = ECHO_FEEDBACK;
    input.connect(lowpass);
    input.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(lowpass);
    lowpass.connect(context.destination);
    bus = { context, input };
    void context.resume().catch(() => undefined);
    return bus;
  } catch {
    return null;
  }
}

function bell(target: Bus, hz: number, at: number, gain: number): void {
  const { context, input } = target;
  const start = context.currentTime + at;
  PARTIALS.forEach((ratio, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = hz * ratio;
    const envelope = context.createGain();
    const peak = gain * PARTIAL_GAIN[index]!;
    const decay = NOTE_DECAY_S / (1 + index * 0.6);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.linearRampToValueAtTime(peak, start + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.006 + decay);
    oscillator.connect(envelope);
    envelope.connect(input);
    oscillator.start(start);
    oscillator.stop(start + 0.006 + decay + 0.05);
  });
}

function phrase(target: Bus): void {
  ARPEGGIO.forEach((hz, index) => bell(target, hz, index * ARPEGGIO_STEP_S, 1));
  for (const note of ECHO) bell(target, note.hz, note.at, note.gain);
}

function notes(hzs: readonly number[]): void {
  const target = ensureBus();
  if (!target) return;
  hzs.forEach((hz, index) => bell(target, hz, index * NOTE_STEP_S, 0.9));
}

/** The tones stand still while sounds are off, and while a call reconnects: the person is already on it. */
export function callTonesAllowed(reconnecting = false): boolean {
  return !reconnecting && notificationSoundsEnabled();
}

export interface Ring {
  /** Lets the phrase that is sounding finish, not the silent part after it, then resolves. */
  stop(): Promise<void>;
}

const SILENT: Ring = { stop: () => Promise.resolve() };

export function startRing(options: { reconnecting?: boolean } = {}): Ring {
  if (!callTonesAllowed(options.reconnecting)) return SILENT;
  const target = ensureBus();
  if (!target) return SILENT;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let phraseEndsAt = 0;
  let stopped = false;
  const ring = () => {
    if (stopped) return;
    phrase(target);
    phraseEndsAt = Date.now() + RING_PHRASE_MS;
    timer = setTimeout(ring, RING_CYCLE_MS);
  };
  ring();
  return {
    stop: () => {
      if (stopped) return Promise.resolve();
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const left = phraseEndsAt - Date.now();
      if (left <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => setTimeout(resolve, left));
    },
  };
}

export function playPickup(options: { reconnecting?: boolean } = {}): void {
  if (callTonesAllowed(options.reconnecting)) notes(PICKUP);
}

export function playHangup(options: { reconnecting?: boolean } = {}): void {
  if (callTonesAllowed(options.reconnecting)) notes(HANGUP);
}

export function resetCallSounds(): void {
  const old = bus;
  bus = null;
  void old?.context.close().catch(() => undefined);
}
