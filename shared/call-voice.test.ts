import { describe, expect, it } from "vitest";

import {
  CALL_LANGUAGES,
  CALL_SPEED_MAX,
  CALL_SPEED_MIN,
  callLanguage,
  callLanguageBase,
  callLanguageInstruction,
  callSpeedFor,
  callVoiceCapability,
  isCallLanguage,
  isCallSpeed,
  type CallVoiceTarget,
} from "./call-voice";

const LIVE = ["openai", "azure", "custom", "elevenlabs", "fish", "gemini", "codex"] as const;
const TURNS = ["elevenlabs", "fish", "system", "chatterbox", "xai", "gemini", "openai", "deepseek", "device"] as const;
const targets: CallVoiceTarget[] = [
  ...LIVE.map((provider) => ({ mode: "live" as const, provider })),
  ...TURNS.map((provider) => ({ mode: "turns" as const, provider })),
];

describe("callVoiceCapability", () => {
  it("keeps every speed range inside the range a bot can save", () => {
    for (const target of targets) {
      const { speed } = callVoiceCapability(target);
      if (speed.kind === "none") continue;
      expect(speed.min).toBeGreaterThanOrEqual(CALL_SPEED_MIN);
      expect(speed.max).toBeLessThanOrEqual(CALL_SPEED_MAX);
      expect(speed.min).toBeLessThan(1);
      expect(speed.max).toBeGreaterThan(1);
    }
  });

  it("gives every Turns provider a speed, natively or through playback", () => {
    for (const provider of TURNS) expect(callVoiceCapability({ mode: "turns", provider }).speed.kind).not.toBe("none");
  });

  it("never plays a Live stream faster, because that raises the pitch", () => {
    for (const provider of LIVE) expect(callVoiceCapability({ mode: "live", provider }).speed.kind).not.toBe("playback");
  });

  it("starts a new Live voice on the next call", () => {
    for (const provider of LIVE) expect(callVoiceCapability({ mode: "live", provider }).voiceApplies).toBe("next-call");
  });

  it("changes OpenAI Live speed from the next reply and ElevenLabs Live speed from the next call", () => {
    expect(callVoiceCapability({ mode: "live", provider: "openai" }).speed).toMatchObject({ kind: "native", applies: "next-reply" });
    expect(callVoiceCapability({ mode: "live", provider: "elevenlabs" }).speed).toMatchObject({ kind: "native", min: 0.7, max: 1.2, applies: "next-call" });
    expect(callVoiceCapability({ mode: "live", provider: "gemini" }).speed).toEqual({ kind: "none", reason: "own-pace" });
  });
});

describe("callSpeedFor", () => {
  const openai = callVoiceCapability({ mode: "live", provider: "openai" }).speed;
  const eleven = callVoiceCapability({ mode: "turns", provider: "elevenlabs" }).speed;

  it("defaults to normal speed", () => expect(callSpeedFor(undefined, openai)).toBe(1));
  it("clamps to the provider range", () => {
    expect(callSpeedFor(2, eleven)).toBe(1.2);
    expect(callSpeedFor(0.5, openai)).toBe(0.75);
  });
  it("rounds to the slider step", () => expect(callSpeedFor(1.13, openai)).toBe(1.15));
  it("sends normal speed to a provider without speed", () => expect(callSpeedFor(1.4, { kind: "none", reason: "own-pace" })).toBe(1));
  it("ignores a saved value outside the bot range", () => expect(callSpeedFor(9, openai)).toBe(1));
});

describe("call languages", () => {
  it("has unique codes", () => expect(new Set(CALL_LANGUAGES.map((language) => language.code)).size).toBe(CALL_LANGUAGES.length));
  it("accepts auto and listed codes only", () => {
    expect(isCallLanguage("auto")).toBe(true);
    expect(isCallLanguage("id")).toBe(true);
    expect(isCallLanguage("xx")).toBe(false);
    expect(isCallLanguage(undefined)).toBe(false);
  });
  it("names the language in the call instructions, and nothing for auto", () => {
    expect(callLanguageInstruction("id")).toContain("Indonesian");
    expect(callLanguageInstruction("auto")).toBeUndefined();
    expect(callLanguageInstruction(undefined)).toBeUndefined();
  });
  it("gives the base code for providers that take ISO 639-1", () => {
    const portuguese = callLanguage("pt-BR");
    expect(portuguese && callLanguageBase(portuguese)).toBe("pt");
  });
  it("validates speeds a bot can save", () => {
    expect(isCallSpeed(1.1)).toBe(true);
    expect(isCallSpeed(0.4)).toBe(false);
    expect(isCallSpeed(Number.NaN)).toBe(false);
    expect(isCallSpeed("1")).toBe(false);
  });
});
