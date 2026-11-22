import { playHangup, playPickup, startRing, type Ring } from "./call-sounds";
import type { CallStage } from "./call-session";

export interface ToneView {
  stage: CallStage;
}

/** Plays the call's tones as its view changes. A call that falls back to calling after it connected is a reconnect and stays quiet. */
export function createCallTones() {
  let ring: Ring | null = null;
  let stage: CallStage | null = null;

  return {
    update(view: ToneView | null): void {
      if (!view) {
        if (stage === null) return;
        const sounding = ring;
        ring = null;
        void sounding?.stop();
        stage = null;
        playHangup();
        return;
      }
      if (view.stage === stage) return;
      const previous = stage;
      stage = view.stage;
      if (view.stage === "calling") {
        if (previous === null) ring = startRing();
        return;
      }
      const sounding = ring;
      ring = null;
      if (sounding) void sounding.stop().then(() => playPickup());
    },
  };
}
