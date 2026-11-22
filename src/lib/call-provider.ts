import type { LiveProvider } from "../../packages/phone-protocol/src/live-call-wire";
import type { TurnsVoiceProvider } from "../../shared/call-voice";
import type { ConfigStatus } from "@/state/config-status";
import { localSystemVoiceActive } from "./local-voice";

/** The voice service that speaks a Turns call: this computer's voices when the person chose them, else the saved voice provider. */
export function turnsCallProvider(config: ConfigStatus | null | undefined): TurnsVoiceProvider {
  if (localSystemVoiceActive()) return "device";
  return config?.tts?.provider ?? "elevenlabs";
}

/** The service a Live call uses: the one the call is on, else the one the call settings chose. */
export function liveCallProvider(config: ConfigStatus | null | undefined, onCall?: LiveProvider): LiveProvider {
  return onCall ?? config?.live?.provider ?? "openai";
}
