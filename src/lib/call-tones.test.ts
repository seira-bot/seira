import { beforeEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({
  started: 0,
  stopped: 0,
  pickups: 0,
  hangups: 0,
  release: null as null | (() => void),
}));

vi.mock("./call-sounds", () => ({
  startRing: () => {
    sounds.started += 1;
    return {
      stop: () => {
        sounds.stopped += 1;
        return new Promise<void>((resolve) => { sounds.release = resolve; });
      },
    };
  },
  playPickup: () => { sounds.pickups += 1; },
  playHangup: () => { sounds.hangups += 1; },
}));

import { createCallTones } from "./call-tones";

beforeEach(() => {
  Object.assign(sounds, { started: 0, stopped: 0, pickups: 0, hangups: 0, release: null });
});

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe("call tones", () => {
  it("rings from the first calling view and plays the pick-up only after the ring finishes", async () => {
    const tones = createCallTones();
    tones.update({ stage: "calling" });
    tones.update({ stage: "calling" });
    expect(sounds.started).toBe(1);
    tones.update({ stage: "connected" });
    expect(sounds.stopped).toBe(1);
    expect(sounds.pickups).toBe(0);
    sounds.release?.();
    await flush();
    expect(sounds.pickups).toBe(1);
  });

  it("plays the hang-up once when the call ends", () => {
    const tones = createCallTones();
    tones.update({ stage: "calling" });
    tones.update({ stage: "connected" });
    tones.update(null);
    tones.update(null);
    expect(sounds.hangups).toBe(1);
  });

  it("stays silent when a connected call falls back to calling and connects again", async () => {
    const tones = createCallTones();
    tones.update({ stage: "calling" });
    tones.update({ stage: "connected" });
    sounds.release?.();
    await flush();
    expect(sounds.pickups).toBe(1);
    tones.update({ stage: "calling" });
    tones.update({ stage: "connected" });
    await flush();
    expect(sounds.started).toBe(1);
    expect(sounds.pickups).toBe(1);
  });

  it("plays nothing when no call was ever shown", () => {
    createCallTones().update(null);
    expect(sounds).toMatchObject({ started: 0, hangups: 0 });
  });

  it("starts a new ring for the next call", () => {
    const tones = createCallTones();
    tones.update({ stage: "calling" });
    tones.update(null);
    tones.update({ stage: "calling" });
    expect(sounds.started).toBe(2);
  });
});
