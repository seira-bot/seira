// The sample a person plays before choosing a Live call voice. Scopes are keyed by path in server/request-auth.ts.
import { CALL_VOICE_PREVIEW_TEXT_MAX, callSpeedFor, callVoiceCapability, isCallSpeed, type CallVoicePreviewRequest } from "../../shared/call-voice.ts";
import { GEMINI_LIVE_VOICE_OPTIONS, LIVE_VOICE_OPTIONS } from "../../shared/live-call.ts";
import { OPENAI_VOICES } from "../../shared/openai-voice.ts";
import type { AppConfig } from "../config.ts";
import { liveKeyTarget, usableLiveKey } from "../live-config.ts";
import { redactSecretsInText } from "../redact.ts";
import * as gemini from "../tts/gemini.ts";
import * as openai from "../tts/openai.ts";
import { voiceFailure } from "../tts/errors.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CallVoicePreviewDeps {
  config(): AppConfig;
}

const PROVIDERS: ReadonlyArray<CallVoicePreviewRequest["provider"]> = ["openai", "azure", "custom", "gemini", "elevenlabs", "fish", "codex"];
const GPT_LIVE = new Set(["openai", "azure", "custom"]);

export function createCallVoicePreviewRoutes(deps: CallVoicePreviewDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (method !== "POST" || path !== "/api/call/voice-preview") return PASS;
    const cfg = deps.config();
    const body = await readBody(req);
    const provider = PROVIDERS.find((one) => one === body.provider);
    if (!provider) return json(res, 400, { error: "provider is not a Live call provider" });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > CALL_VOICE_PREVIEW_TEXT_MAX) return json(res, 400, { error: `text must be 1 to ${CALL_VOICE_PREVIEW_TEXT_MAX} characters` });
    if (body.speed !== undefined && !isCallSpeed(body.speed)) return json(res, 400, { error: "speed must be a number from 0.5 to 2" });
    const speed = body.speed as number | undefined;
    const voice = typeof body.voice === "string" ? body.voice : "";
    // These voices live in the provider's call agent and have no sample outside a call.
    if (provider === "elevenlabs" || provider === "fish" || provider === "codex") return json(res, 404, { error: "no sample for this voice" });
    const known = (provider === "gemini" ? GEMINI_LIVE_VOICE_OPTIONS : LIVE_VOICE_OPTIONS).some((option) => option.id === voice);
    if (!known) return json(res, 400, { error: "voice is not one of this provider's call voices" });

    const spoken = redactSecretsInText(text);
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", cancel);
    try {
      let audio: { bytes: Uint8Array; mime: string };
      if (GPT_LIVE.has(provider)) {
        // A Live key saved for Azure or a custom gateway never goes to the OpenAI host.
        const liveKey = provider === "openai" && liveKeyTarget(cfg.live) === "openai" ? usableLiveKey(cfg.live) : undefined;
        const key = cfg.openai?.key?.trim() || liveKey;
        if (!key || !OPENAI_VOICES.some((id) => id === voice)) return json(res, 404, { error: "no sample for this voice" });
        audio = await openai.synthesize(spoken, voice, key, controller.signal, undefined, speed === undefined ? undefined : callSpeedFor(speed, callVoiceCapability({ mode: "live", provider: "openai" }).speed));
      } else {
        const key = cfg.tts?.geminiKey?.trim();
        if (!key) return json(res, 404, { error: "no sample for this voice" });
        audio = await gemini.synthesize(spoken, voice, key, cfg.tts?.model);
      }
      if (controller.signal.aborted) return;
      res.writeHead(200, { "content-type": audio.mime, "content-length": String(audio.bytes.byteLength), "cache-control": "no-store" });
      res.end(Buffer.from(audio.bytes));
      return;
    } catch (e) {
      if (controller.signal.aborted) return;
      const failure = voiceFailure(e);
      if (failure) return json(res, failure.status, failure.body);
      return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      res.off("close", cancel);
    }
  };
}
