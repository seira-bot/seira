import { describe, expect, it, vi } from "vitest";
import { fishKeyPrint, fishLiveEndpoint } from "./live-fish.ts";
import { elevenLabsLiveEndpoint } from "./live-elevenlabs.ts";
import { liveSessionWiring, type LiveSessionWiringInput } from "./live-session-wiring.ts";
import { EngineLiveVoiceError, type EngineLiveVoiceEvent, type EngineLiveVoiceSession, type EngineLiveVoiceStart } from "./contracts.ts";
import { codexLiveEndpoint, liveErrorMessage, LIVE_CODEX_CLOUD, LIVE_CODEX_ENGINE, LIVE_CODEX_NO_ANSWER, LIVE_CODEX_SIGN_IN, LIVE_CODEX_UPDATE } from "./live-call.ts";

const TOKEN = { transport: "livekit", session_id: "sess_1", expires_at: "x", max_duration_seconds: 900, livekit_url: "wss://lk.fish.audio", token: "jwt" };

function fakeFish({ goneAgents = [] as string[], refuseConfig = false } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = `${init!.method} ${String(url).replace("https://api.fish.audio/v1/agent", "")}`;
    if (route === "POST /sessions") {
      const agent = JSON.parse(String(init!.body)).agent_id as string;
      return goneAgents.includes(agent) ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(TOKEN), { status: 201 });
    }
    if (refuseConfig && route.endsWith("/config")) return new Response("{}", { status: 500 });
    const answers: Record<string, unknown> = { "POST /tools": { tool_id: "tool_1" }, "POST /agents": { agent_id: "agent_new" } };
    return new Response(JSON.stringify(answers[route] ?? {}), { status: 200 });
  });
}

function wiring(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}, speech: { language?: string; fishAgentLanguage?: string } = {}) {
  const saveAgent = vi.fn();
  const wired = liveSessionWiring({
    bot: () => ({ name: "Rigel" }), history: () => [], cloudHome: false, othersOnLoopback: () => false, saveAgent, productName: () => "Acme", env, fetchImpl,
    language: () => speech.language, fishAgentLanguage: () => speech.fishAgentLanguage,
  });
  return { ...wired, saveAgent };
}

const start = { key: "fish-key", sdp: "", botId: "b1", threadId: "t1", voice: "agent" };
const routes = (fetchImpl: ReturnType<typeof fakeFish>) => fetchImpl.mock.calls.map(([url, init]) => `${init!.method} ${String(url).replace("https://api.fish.audio/v1/agent", "")}`);

describe("a Fish Audio call's session", () => {
  it("sets up an agent on the first call, saves it for that key's account, and answers with a relay", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl);
    const answer = await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("", {}) });
    expect(routes(fetchImpl)).toEqual(["POST /tools", "POST /agents", "PATCH /agents/agent_new", "POST /agents/agent_new/publish", "POST /sessions"]);
    expect(w.saveAgent).toHaveBeenCalledWith({ fishAgentId: "agent_new", fishAgentFor: fishKeyPrint("fish-key"), fishAgentLanguage: "en" });
    const created = fetchImpl.mock.calls.find(([url, init]) => init!.method === "POST" && String(url).endsWith("/agents"))!;
    expect(JSON.parse(String(created[1]!.body)).name).toBe("Acme Live calls");
    expect(answer).toMatchObject({ sessionId: "sess_1", fish: { type: "fish", session: TOKEN } });
    const relayToken = (answer as { fish: { relayToken: string } }).fish.relayToken;
    expect(w.fishRelay("sess_1", relayToken)).not.toBeNull();
    expect(w.fishRelay("sess_1", "guessed")).toBeNull();
  });

  it("starts the saved agent without setting one up", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl);
    await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) });
    expect(routes(fetchImpl)).toEqual(["POST /sessions"]);
    expect(w.saveAgent).not.toHaveBeenCalled();
  });

  it("sets up a new agent once when the saved one is gone on Fish Audio", async () => {
    const fetchImpl = fakeFish({ goneAgents: ["agent_saved"] });
    const w = wiring(fetchImpl);
    await expect(w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) })).resolves.toMatchObject({ sessionId: "sess_1" });
    expect(routes(fetchImpl)).toEqual(["POST /sessions", "POST /tools", "POST /agents", "PATCH /agents/agent_new", "POST /agents/agent_new/publish", "POST /sessions"]);
    expect(w.saveAgent).toHaveBeenCalledTimes(1);
  });

  it("sets up a new agent in the app's language", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl, {}, { language: "vi" });
    await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("", {}) });
    const created = fetchImpl.mock.calls.find(([url, init]) => init!.method === "POST" && String(url).endsWith("/agents"))!;
    expect(JSON.parse(String(created[1]!.body)).config.voice.speaking_language).toBe("vi");
    expect(w.saveAgent).toHaveBeenCalledWith({ fishAgentId: "agent_new", fishAgentFor: fishKeyPrint("fish-key"), fishAgentLanguage: "vi" });
  });

  it("moves the saved agent to the app's language before the call, once", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl, {}, { language: "vi" });
    await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) });
    expect(routes(fetchImpl)).toEqual(["PATCH /agents/agent_saved/config", "POST /agents/agent_saved/publish", "POST /sessions"]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({ voice: { speaking_language: "vi" } });
    expect(w.saveAgent).toHaveBeenCalledWith({ fishAgentId: "agent_saved", fishAgentFor: fishKeyPrint("fish-key"), fishAgentLanguage: "vi" });

    const again = fakeFish();
    const moved = wiring(again, {}, { language: "vi", fishAgentLanguage: "vi" });
    await moved.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) });
    expect(routes(again)).toEqual(["POST /sessions"]);
    expect(moved.saveAgent).not.toHaveBeenCalled();
  });

  it("changes the agent's language one call start at a time, so the app's latest language is the one left saved", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fish = fakeFish();
    let patches = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init!.method === "PATCH" && patches++ === 0) await firstHeld;
      return fish(url, init);
    });
    const speech: { language?: string; fishAgentLanguage?: string } = { language: "de", fishAgentLanguage: "en" };
    const w = wiring(fetchImpl as unknown as typeof fetch, {}, speech);
    w.saveAgent.mockImplementation((agent: { fishAgentLanguage: string }) => { speech.fishAgentLanguage = agent.fishAgentLanguage; });
    const endpoint = fishLiveEndpoint("agent_saved", {});
    const first = w.calls.createSession({ ...start, endpoint });
    speech.language = "fr";
    const second = w.calls.createSession({ ...start, endpoint });
    releaseFirst();
    await Promise.all([first, second]);
    const languages = fish.mock.calls.filter(([, init]) => init!.method === "PATCH").map(([, init]) => JSON.parse(String(init!.body)).voice.speaking_language);
    expect(languages).toEqual(["de", "fr"]);
    expect(speech.fishAgentLanguage).toBe("fr");
  });

  it("still starts the call when Fish won't change the agent's language", async () => {
    const fetchImpl = fakeFish({ refuseConfig: true });
    const w = wiring(fetchImpl, {}, { language: "vi" });
    await expect(w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) })).resolves.toMatchObject({ sessionId: "sess_1" });
    expect(routes(fetchImpl)).toEqual(["PATCH /agents/agent_saved/config", "POST /sessions"]);
    expect(w.saveAgent).not.toHaveBeenCalled();
  });

  it("never changes the language of an agent the operator chose", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl, { SEIRA_FISH_LIVE_AGENT_ID: "agent_op" }, { language: "vi" });
    await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_op", {}) });
    expect(routes(fetchImpl)).toEqual(["POST /sessions"]);
  });

  it("never replaces an agent the operator chose", async () => {
    const fetchImpl = fakeFish({ goneAgents: ["agent_op"] });
    const w = wiring(fetchImpl, { SEIRA_FISH_LIVE_AGENT_ID: "agent_op" });
    await expect(w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_op", {}) })).rejects.toMatchObject({ status: 502 });
    expect(routes(fetchImpl)).toEqual(["POST /sessions"]);
    expect(w.saveAgent).not.toHaveBeenCalled();
  });

  it("follows the call through its relay, not a socket to Fish", () => {
    const w = wiring(fakeFish());
    const endpoint = fishLiveEndpoint("agent_1", {});
    expect(w.calls.attachUrl("sess_9", endpoint)).toBe("sess_9");
    expect(() => w.calls.openSocket("sess_9", "k", endpoint)).toThrow("no relay for that session");
  });
});

describe("a Gemini Live call's session", () => {
  const gemini = { provider: "gemini" as const, apiBase: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.8-live" };

  it("takes a token from Gemini and answers with it and a relay, never the key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/t1" }), { status: 200 }));
    const w = wiring(fetchImpl as unknown as typeof fetch);
    const answer = await w.calls.createSession({ ...start, key: "gemini-secret", endpoint: gemini });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({ gemini: { type: "gemini", session: { token: "auth_tokens/t1" } } });
    expect(JSON.stringify(answer)).not.toContain("gemini-secret");
    const { session, relayToken } = (answer as { gemini: { session: { session_id: string }; relayToken: string } }).gemini;
    expect(answer.sessionId).toBe(session.session_id);
    expect(w.fishRelay(session.session_id, relayToken)).not.toBeNull();
    expect(w.calls.attachUrl(session.session_id, gemini)).toBe(session.session_id);
    expect(w.calls.openSocket(session.session_id, "k", gemini)).toBeTruthy();
  });

  it("asks who is calling as for Fish Audio", () => {
    const w = wiring(fakeFish());
    expect(w.calls.geminiRefusal({ kind: "loopback", scopes: ["admin", "client"] })).toBeNull();
  });
});

describe("an ElevenLabs call's session", () => {
  const SIGNED = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_new&conversation_signature=s";
  function fakeElevenLabs({ goneAgents = [] as string[] } = {}) {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const { pathname, searchParams } = new URL(String(url));
      if (pathname.endsWith("/tools")) return Response.json({ id: "tool_1" });
      if (pathname.endsWith("/agents/create")) return Response.json({ agent_id: "agent_new" });
      const agent = searchParams.get("agent_id") ?? "";
      return goneAgents.includes(agent) ? new Response("{}", { status: 404 }) : Response.json({ signed_url: SIGNED });
    });
  }
  const paths = (fetchImpl: ReturnType<typeof fakeElevenLabs>) => fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname.replace("/v1/convai", ""));
  const eleven = { ...start, key: "eleven-key" };

  it("sets up an agent on the first call, saves it for that key's account, and answers with a relay, never the key", async () => {
    const fetchImpl = fakeElevenLabs();
    const w = wiring(fetchImpl as unknown as typeof fetch);
    const answer = await w.calls.createSession({ ...eleven, endpoint: elevenLabsLiveEndpoint(null, {}) });
    expect(paths(fetchImpl)).toEqual(["/tools", "/agents/create", "/conversation/get-signed-url"]);
    expect(w.saveAgent).toHaveBeenCalledWith({ elevenlabsAgentId: "agent_new", elevenlabsAgentFor: fishKeyPrint("eleven-key") });
    expect(answer).toMatchObject({ elevenlabs: { type: "elevenlabs", session: { signed_url: SIGNED } } });
    expect(JSON.stringify(answer)).not.toContain("eleven-key");
    const { session, relayToken } = (answer as { elevenlabs: { session: { session_id: string }; relayToken: string } }).elevenlabs;
    expect(answer.sessionId).toBe(session.session_id);
    expect(w.fishRelay(session.session_id, relayToken)).not.toBeNull();
    expect(w.calls.attachUrl(session.session_id, elevenLabsLiveEndpoint("agent_new", {}))).toBe(session.session_id);
  });

  it("uses the saved agent without setting one up", async () => {
    const fetchImpl = fakeElevenLabs();
    const w = wiring(fetchImpl as unknown as typeof fetch);
    await w.calls.createSession({ ...eleven, endpoint: elevenLabsLiveEndpoint("agent_1", {}) });
    expect(paths(fetchImpl)).toEqual(["/conversation/get-signed-url"]);
    expect(w.saveAgent).not.toHaveBeenCalled();
  });

  it("sets the agent up again when it was removed on ElevenLabs", async () => {
    const fetchImpl = fakeElevenLabs({ goneAgents: ["agent_old"] });
    const w = wiring(fetchImpl as unknown as typeof fetch);
    await w.calls.createSession({ ...eleven, endpoint: elevenLabsLiveEndpoint("agent_old", {}) });
    expect(paths(fetchImpl)).toEqual(["/conversation/get-signed-url", "/tools", "/agents/create", "/conversation/get-signed-url"]);
    expect(w.saveAgent).toHaveBeenCalledTimes(1);
  });

  it("asks who is calling as for Fish Audio", () => {
    const w = wiring(fakeFish());
    expect(w.calls.elevenlabsRefusal({ kind: "loopback", scopes: ["admin", "client"] })).toBeNull();
  });
});

describe("a Codex call's session", () => {
  const offer = "v=0 offer";
  function codexWiring(over: Partial<LiveSessionWiringInput> & { start?: (input: EngineLiveVoiceStart) => Promise<EngineLiveVoiceSession> } = {}) {
    const stop = vi.fn(async () => {});
    const inputs: EngineLiveVoiceStart[] = [];
    const posted: Array<{ botId: string; threadId: string; text: string }> = [];
    const { start, ...rest } = over;
    const startLiveVoice = vi.fn(start ?? (async (input: EngineLiveVoiceStart) => { inputs.push(input); return { sdp: "answer sdp\r\n", appendText: vi.fn(), appendSpeech: vi.fn(), stop }; }));
    const wired = liveSessionWiring({
      bot: () => ({ name: "Rigel" }), history: () => [{ role: "user", text: "hello" }], cloudHome: false, othersOnLoopback: () => false, saveAgent: vi.fn(),
      codexLive: () => ({ startLiveVoice, cwd: "/work", approvalMode: "ask" as never, botId: "b1", model: "gpt-5.5" }),
      postCallAnswer: (a) => posted.push(a), fetchImpl: vi.fn() as never, ...rest,
    });
    return { ...wired, startLiveVoice, inputs, posted, stop };
  }
  const create = (w: ReturnType<typeof codexWiring>, sdp = offer) => w.calls.createSession({ key: "", endpoint: codexLiveEndpoint(), sdp, botId: "b1", threadId: "t1", voice: "" });

  it("starts the voice with the folder, approval mode, instructions and history, and returns Codex's answer unchanged", async () => {
    const w = codexWiring();
    const answer = await create(w);
    expect(answer).toMatchObject({ sdp: "answer sdp\r\n" });
    expect(w.inputs[0]).toMatchObject({ sdp: offer, cwd: "/work", botId: "b1", model: "gpt-5.5", approvalMode: "ask", history: [{ role: "user", text: "hello" }] });
    expect(w.inputs[0]!.voiceInstructions).toContain("Rigel");
    expect(w.inputs[0]!.workInstructions).toContain("Rigel");
  });

  it("hands the tool selection, the guest confinement and the abort signal of the start to the voice", async () => {
    const inputs: EngineLiveVoiceStart[] = [];
    const startLiveVoice = async (input: EngineLiveVoiceStart) => { inputs.push(input); return { sdp: "a", appendText: vi.fn(), appendSpeech: vi.fn(), stop: vi.fn(async () => {}) }; };
    const w = codexWiring({ codexLive: () => ({ startLiveVoice, cwd: "/work", approvalMode: "ask" as never, botId: "b1", model: null, toolScoped: true, guestConfined: true }) });
    const signal = new AbortController().signal;
    await w.calls.createSession({ key: "", endpoint: codexLiveEndpoint(), sdp: offer, botId: "b1", threadId: "t1", voice: "", signal });
    expect(inputs[0]).toMatchObject({ toolScoped: true, guestConfined: true, signal });
  });

  it("refuses and stops the session when Codex reports a failure before the session is attached", async () => {
    const stop = vi.fn(async () => {});
    const w = codexWiring({ start: async (input) => {
      input.onEvent({ type: "failed", reason: "error" });
      return { sdp: "a", appendText: vi.fn(), appendSpeech: vi.fn(), stop };
    } });
    await expect(create(w)).rejects.toMatchObject({ status: 502, message: liveErrorMessage(500, undefined, "codex") });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await w.stopAll();
    expect(stop).toHaveBeenCalledOnce();
    expect(w.calls.openSocket("anything", "", codexLiveEndpoint()).readyState).toBe(3);
  });

  it("waits in stopAll for a stop that began when the socket closed", async () => {
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const w = codexWiring({ start: async () => ({ sdp: "a", appendText: vi.fn(), appendSpeech: vi.fn(), stop }) });
    const { sessionId } = await create(w);
    w.calls.openSocket(sessionId, "", codexLiveEndpoint()).close(1000);
    expect(stop).toHaveBeenCalledOnce();
    let done = false;
    const stopping = w.stopAll().then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    release();
    await stopping;
    expect(done).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("refuses when the bot's engine cannot take the call", async () => {
    const w = codexWiring({ codexLive: () => null });
    await expect(create(w)).rejects.toMatchObject({ status: 409, message: LIVE_CODEX_ENGINE });
    expect(w.startLiveVoice).not.toHaveBeenCalled();
  });

  it("refuses on a cloud home, and for a missing or oversized offer, before starting Codex", async () => {
    const cloud = codexWiring({ cloudHome: true });
    await expect(create(cloud)).rejects.toMatchObject({ status: 409, message: LIVE_CODEX_CLOUD });
    const w = codexWiring();
    await expect(create(w, "  ")).rejects.toMatchObject({ status: 400 });
    await expect(create(w, "x".repeat(200_000))).rejects.toMatchObject({ status: 400 });
    expect(w.startLiveVoice).not.toHaveBeenCalled();
  });

  it("maps each refusal of the engine to its message", async () => {
    const cases: Array<[ConstructorParameters<typeof EngineLiveVoiceError>[0], number, string]> = [
      ["not-signed-in", 409, LIVE_CODEX_SIGN_IN],
      ["too-old", 409, LIVE_CODEX_UPDATE],
      ["unsupported-sign-in", 409, LIVE_CODEX_ENGINE],
      ["no-answer", 502, LIVE_CODEX_NO_ANSWER],
      ["failed", 502, liveErrorMessage(500, undefined, "codex")],
    ];
    for (const [refusal, status, message] of cases) {
      const w = codexWiring({ start: async () => { throw new EngineLiveVoiceError(refusal); } });
      await expect(create(w), refusal).rejects.toMatchObject({ status, message });
    }
    const other = codexWiring({ start: async () => { throw new Error("spawn"); } });
    await expect(create(other)).rejects.toMatchObject({ status: 502 });
  });

  it("adds each answer of the engine to the chat", async () => {
    let onEvent!: (event: EngineLiveVoiceEvent) => void;
    const w = codexWiring({ start: async (input) => { onEvent = input.onEvent; return { sdp: "a", appendText: vi.fn(), appendSpeech: vi.fn(), stop: vi.fn(async () => {}) }; } });
    await create(w);
    onEvent({ type: "answer", text: "All done." } as never);
    expect(w.posted).toEqual([{ botId: "b1", threadId: "t1", text: "All done." }]);
  });

  it("follows the session through a socket that carries its events and stops it", async () => {
    let onEvent!: (event: EngineLiveVoiceEvent) => void;
    const stop = vi.fn(async () => {});
    const w = codexWiring({ start: async (input) => { onEvent = input.onEvent; return { sdp: "a", appendText: vi.fn(), appendSpeech: vi.fn(), stop }; } });
    const { sessionId } = await create(w);
    const url = w.calls.attachUrl(sessionId, codexLiveEndpoint());
    expect(url).toBe(sessionId);
    const socket = w.calls.openSocket(url, "", codexLiveEndpoint());
    const types: string[] = [];
    socket.onmessage = (e) => types.push(JSON.parse(String(e.data)).type);
    onEvent({ type: "started" });
    expect(types).toEqual(["session.started"]);
    socket.close(1000);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("opens an already closed socket for a session it does not know", () => {
    const w = codexWiring();
    const socket = w.calls.openSocket("missing", "", codexLiveEndpoint());
    expect(socket.readyState).toBe(3);
  });

  it("stops every open session on stopAll, once each", async () => {
    const w = codexWiring();
    await create(w);
    await create(w);
    await w.stopAll();
    await w.stopAll();
    expect(w.stop).toHaveBeenCalledTimes(2);
  });

  describe("a call that ends before Codex is live", () => {
    function pending() {
      const stop = vi.fn(async () => {});
      let resolve!: (session: EngineLiveVoiceSession) => void;
      let reject!: (error: Error) => void;
      const start = () => new Promise<EngineLiveVoiceSession>((done, fail) => { resolve = done; reject = fail; });
      const session: EngineLiveVoiceSession = { sdp: "late answer", appendText: vi.fn(), appendSpeech: vi.fn(), stop };
      return { stop, start, session, resolve: () => resolve(session), reject: (error: Error) => reject(error) };
    }

    it("stops the session once when the start resolves after stopAll, and keeps no socket", async () => {
      const p = pending();
      const w = codexWiring({ start: p.start });
      const creating = create(w);
      await w.stopAll();
      p.resolve();
      await expect(creating).resolves.toMatchObject({ sdp: "late answer" });
      await vi.waitFor(() => expect(p.stop).toHaveBeenCalledOnce());
      await w.stopAll();
      expect(p.stop).toHaveBeenCalledOnce();
      expect(w.calls.openSocket("anything", "", codexLiveEndpoint()).readyState).toBe(3);
    });

    it("stops the session once when the caller closes the socket of a start that has just resolved", async () => {
      const p = pending();
      const w = codexWiring({ start: p.start });
      const creating = create(w);
      p.resolve();
      const { sessionId } = await creating;
      const socket = w.calls.openSocket(w.calls.attachUrl(sessionId, codexLiveEndpoint()), "", codexLiveEndpoint());
      socket.close(1000);
      socket.close(1000);
      await w.stopAll();
      expect(p.stop).toHaveBeenCalledOnce();
      expect(w.calls.openSocket(sessionId, "", codexLiveEndpoint()).readyState).toBe(3);
    });

    it("rejects without an unhandled rejection when a start fails after the call ended", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const p = pending();
        const w = codexWiring({ start: p.start });
        const creating = create(w);
        await w.stopAll();
        p.reject(new EngineLiveVoiceError("no-answer"));
        await expect(creating).rejects.toMatchObject({ status: 502, message: LIVE_CODEX_NO_ANSWER });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).not.toHaveBeenCalled();
        expect(p.stop).not.toHaveBeenCalled();
        await expect(w.stopAll()).resolves.toBeUndefined();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });

  it("forgets a session whose start failed, so stopAll has nothing to stop", async () => {
    const w = codexWiring({ start: async () => { throw new EngineLiveVoiceError("no-answer"); } });
    await expect(create(w)).rejects.toBeTruthy();
    await expect(w.stopAll()).resolves.toBeUndefined();
  });
});
