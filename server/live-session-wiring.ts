import { randomUUID } from "node:crypto";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import { productName } from "./brand.ts";
import { EngineLiveVoiceError, type EngineLiveVoiceSession, type EngineLiveVoiceStart } from "./contracts.ts";
import type { LiveCallDeps } from "./live-call-controller.ts";
import { openLiveSocket, relayedProvider } from "./live-call-controller.ts";
import {
  createLiveSession, LIVE_CODEX_CLOUD, LIVE_CODEX_ENGINE, LIVE_CODEX_NO_ANSWER, LIVE_CODEX_SIGN_IN, LIVE_CODEX_UPDATE, liveAttachUrl, liveErrorMessage, LiveSessionError, MAX_SDP_BYTES,
  type LiveBot, type LiveEndpoint, type LiveHistoryMessage,
} from "./live-call.ts";
import { codexCallHistory, codexVoiceInstructions, codexWorkInstructions } from "./live-codex.ts";
import { LiveCodexSocket } from "./live-codex-socket.ts";
import { elevenLabsLiveCallRefusal, fishLiveCallRefusal, geminiLiveCallRefusal } from "./live-access.ts";
import type { LiveConfig } from "./live-config.ts";
import { createFishLiveSession, endFishLiveSession, fishKeyPrint, FishRelays, fishSpeakingLanguage, setFishAgentLanguage, setUpFishAgent } from "./live-fish.ts";
import { createElevenLabsLiveSession, setUpElevenLabsAgent } from "./live-elevenlabs.ts";
import { createGeminiLiveSession } from "./live-gemini.ts";
import type { LiveRouteDeps } from "./routes/live.ts";

export interface LiveSessionWiringInput {
  bot(botId: string): LiveBot;
  history(threadId: string): LiveHistoryMessage[];
  cloudHome: boolean;
  othersOnLoopback(): boolean;
  /** Saves the Fish Audio or ElevenLabs agent the harness set up, with the account it belongs to. */
  saveAgent(agent: Required<Pick<LiveConfig, "fishAgentId" | "fishAgentFor" | "fishAgentLanguage">> | Required<Pick<LiveConfig, "elevenlabsAgentId" | "elevenlabsAgentFor">>): void;
  /** The voice hook and run settings of the engine the bot's conversation runs on; null when that engine is not Codex or has no voice. */
  codexLive?(botId: string, threadId: string): { startLiveVoice(input: EngineLiveVoiceStart): Promise<EngineLiveVoiceSession>; cwd: string; approvalMode: ApprovalMode; botId: string; model: string | null; toolScoped?: boolean; guestConfined?: boolean } | null;
  /** Adds what the bot's engine answered during a Codex call to the chat; the voice already spoke it. */
  postCallAnswer?(input: { botId: string; threadId: string; text: string }): void;
  /** The app's language, which a Fish Audio agent speaks; English when unset. */
  language?(): string | undefined;
  /** The language the saved Fish Audio agent was last set to speak (`LiveConfig.fishAgentLanguage`). */
  fishAgentLanguage?(): string | undefined;
  /** The name a person reads, which names the agent on their account; the brand's own by default. */
  productName?(): string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** How a Live call's session starts and is followed, per provider: GPT-Live's WebRTC session and sideband on OpenAI or
 * Azure, or a Fish Audio agent, Gemini Live session or ElevenLabs agent conversation followed through its client's relay. */
export function liveSessionWiring(input: LiveSessionWiringInput): {
  calls: Pick<LiveCallDeps, "fishRefusal" | "geminiRefusal" | "elevenlabsRefusal" | "createSession" | "openSocket" | "attachUrl">;
  fishRelay: LiveRouteDeps["fishRelay"];
  /** Stops every open Codex voice session. */
  stopAll(): Promise<void>;
} {
  const relays = new FishRelays();
  const relayed = (endpoint: LiveEndpoint) => relayedProvider(endpoint.provider) !== null;
  const codexSockets = new Map<string, LiveCodexSocket>();
  const stopsInFlight = new Set<Promise<void>>();
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;

  const operatorAgent = () => Boolean(env.SEIRA_FISH_LIVE_AGENT_ID?.trim());

  const setUpAgent = async (key: string, endpoint: LiveEndpoint, language: string): Promise<LiveEndpoint> => {
    const fishAgentId = await setUpFishAgent(key, endpoint, (input.productName ?? productName)(), language, fetchImpl);
    input.saveAgent({ fishAgentId, fishAgentFor: fishKeyPrint(key), fishAgentLanguage: language });
    return { ...endpoint, model: fishAgentId };
  };

  // Moves the saved agent the harness set up to the app's language; if Fish refuses, the call goes ahead in the old one.
  // One change at a time, even past a cancelled call start, so a slower earlier start never saves over a later one.
  let languageChange: Promise<void> = Promise.resolve();
  const speakLanguage = (key: string, endpoint: LiveEndpoint, language: string): Promise<void> => {
    const change = languageChange.then(async () => {
      if (operatorAgent() || (input.fishAgentLanguage?.() ?? "en") === language) return;
      try {
        await setFishAgentLanguage(key, endpoint, endpoint.model, language, fetchImpl);
      } catch {
        return;
      }
      input.saveAgent({ fishAgentId: endpoint.model, fishAgentFor: fishKeyPrint(key), fishAgentLanguage: language });
    });
    languageChange = change.catch(() => undefined);
    return change;
  };

  const startFish = async (key: string, endpoint: LiveEndpoint, botId: string, threadId: string) => {
    const session = { key, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome, fetchImpl };
    const language = fishSpeakingLanguage(input.language?.());
    if (endpoint.model) await speakLanguage(key, endpoint, language);
    let agent = endpoint.model ? endpoint : await setUpAgent(key, endpoint, language);
    try {
      return { agent, token: await createFishLiveSession({ ...session, endpoint: agent }) };
    } catch (error) {
      // An agent removed on Fish Audio is set up again, unless the operator chose it.
      const gone = (error as { fishStatus?: number }).fishStatus === 404 && endpoint.model !== "" && !operatorAgent();
      if (!gone) throw error;
      agent = await setUpAgent(key, endpoint, language);
      return { agent, token: await createFishLiveSession({ ...session, endpoint: agent }) };
    }
  };

  const setUpElevenLabs = async (key: string, endpoint: LiveEndpoint): Promise<LiveEndpoint> => {
    const elevenlabsAgentId = await setUpElevenLabsAgent(key, endpoint, (input.productName ?? productName)(), fetchImpl);
    input.saveAgent({ elevenlabsAgentId, elevenlabsAgentFor: fishKeyPrint(key) });
    return { ...endpoint, model: elevenlabsAgentId };
  };

  const startElevenLabs = async (key: string, endpoint: LiveEndpoint, botId: string, threadId: string) => {
    const session = { key, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome, fetchImpl };
    try {
      return await createElevenLabsLiveSession({ ...session, endpoint: endpoint.model ? endpoint : await setUpElevenLabs(key, endpoint) });
    } catch (error) {
      // An agent removed on ElevenLabs is set up again.
      if ((error as { elevenlabsStatus?: number }).elevenlabsStatus !== 404 || !endpoint.model) throw error;
      return createElevenLabsLiveSession({ ...session, endpoint: await setUpElevenLabs(key, endpoint) });
    }
  };

  const codexRefusal = (error: unknown): LiveSessionError => {
    const refusal = error instanceof EngineLiveVoiceError ? error.refusal : "failed";
    if (refusal === "not-signed-in") return new LiveSessionError(LIVE_CODEX_SIGN_IN, 409);
    if (refusal === "too-old") return new LiveSessionError(LIVE_CODEX_UPDATE, 409);
    if (refusal === "unsupported-sign-in") return new LiveSessionError(LIVE_CODEX_ENGINE, 409);
    if (refusal === "no-answer") return new LiveSessionError(LIVE_CODEX_NO_ANSWER, 502);
    return new LiveSessionError(liveErrorMessage(500, undefined, "codex"), 502);
  };

  const startCodex = async (sdp: string, botId: string, threadId: string, signal?: AbortSignal) => {
    if (input.cloudHome) throw new LiveSessionError(LIVE_CODEX_CLOUD, 409);
    if (!sdp.trim() || Buffer.byteLength(sdp) > MAX_SDP_BYTES) throw new LiveSessionError("The call could not start: the connection offer was invalid.", 400);
    const engine = input.codexLive?.(botId, threadId) ?? null;
    if (!engine) throw new LiveSessionError(LIVE_CODEX_ENGINE, 409);
    const bot = input.bot(botId);
    const sessionId = randomUUID();
    const socket = new LiveCodexSocket({
      onClosed: () => codexSockets.delete(sessionId),
      onStop: (stop) => { stopsInFlight.add(stop); void stop.finally(() => stopsInFlight.delete(stop)); },
    });
    codexSockets.set(sessionId, socket);
    try {
      const session = await engine.startLiveVoice({
        sdp,
        cwd: engine.cwd,
        botId: engine.botId,
        model: engine.model,
        approvalMode: engine.approvalMode,
        toolScoped: engine.toolScoped,
        guestConfined: engine.guestConfined,
        signal,
        voiceInstructions: codexVoiceInstructions(bot, { cloudHome: input.cloudHome }),
        workInstructions: codexWorkInstructions(bot),
        history: codexCallHistory(input.history(threadId)),
        onEvent: (event) => {
          socket.event(event);
          if (event.type === "answer") input.postCallAnswer?.({ botId, threadId, text: event.text });
        },
      });
      socket.attach(session);
      if (socket.closedByEngine) {
        await socket.stop();
        throw new EngineLiveVoiceError("failed");
      }
      return { sessionId, sdp: session.sdp };
    } catch (error) {
      codexSockets.delete(sessionId);
      throw codexRefusal(error);
    }
  };

  const codexSocket = (sessionId: string): LiveCodexSocket => {
    const found = codexSockets.get(sessionId);
    if (found) return found;
    const closed = new LiveCodexSocket();
    closed.close();
    return closed;
  };

  return {
    fishRelay: (sessionId, token) => relays.find(sessionId, token),
    stopAll: async () => {
      const stops = [...codexSockets.values()].map((socket) => socket.stop());
      await Promise.all([...stops, ...stopsInFlight]);
    },
    calls: {
      fishRefusal: (auth) => fishLiveCallRefusal(auth, { othersOnLoopback: input.othersOnLoopback() }),
      geminiRefusal: (auth) => geminiLiveCallRefusal(auth, { othersOnLoopback: input.othersOnLoopback() }),
      elevenlabsRefusal: (auth) => elevenLabsLiveCallRefusal(auth, { othersOnLoopback: input.othersOnLoopback() }),
      createSession: async ({ key, endpoint, sdp, botId, threadId, voice, signal }) => {
        if (endpoint.provider === "codex") return startCodex(sdp, botId, threadId, signal);
        if (endpoint.provider === "gemini") {
          const session = await createGeminiLiveSession({ key, endpoint, voice, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome, fetchImpl });
          // Gemini has nothing to end: the session ends when the client closes it, and the token is single use.
          const { token } = relays.open(session.session_id, async () => undefined);
          return { sessionId: session.session_id, gemini: { type: "gemini", session, relayToken: token } };
        }
        if (endpoint.provider === "elevenlabs") {
          const session = await startElevenLabs(key, endpoint, botId, threadId);
          // ElevenLabs has nothing to end either: the conversation ends when the client closes it.
          const { token } = relays.open(session.session_id, async () => undefined);
          return { sessionId: session.session_id, elevenlabs: { type: "elevenlabs", session, relayToken: token } };
        }
        if (endpoint.provider !== "fish") {
          return createLiveSession({ key, endpoint, sdp, voice, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome });
        }
        const { agent, token: session } = await startFish(key, endpoint, botId, threadId);
        const { token } = relays.open(session.session_id, () => endFishLiveSession(session.session_id, key, agent, fetchImpl));
        return { sessionId: session.session_id, fish: { type: "fish", session, relayToken: token } };
      },
      openSocket: (url, key, endpoint) => endpoint.provider === "codex" ? codexSocket(url) : relayed(endpoint) ? relays.socket(url) : openLiveSocket(url, key, endpoint),
      attachUrl: (sessionId, endpoint) => relayed(endpoint) || endpoint.provider === "codex" ? sessionId : liveAttachUrl(sessionId, endpoint),
    },
  };
}

/** Ends the running call first, so it is recorded as a shutdown, then waits for every Codex session to stop. */
export async function shutdownLiveCalls(calls: { shutdown(): Promise<void> }, wiring: { stopAll(): Promise<void> }): Promise<void> {
  try {
    try { await calls.shutdown(); } finally { await wiring.stopAll(); }
  } catch (error) { console.warn("live: stopping Codex calls failed", error); }
}
