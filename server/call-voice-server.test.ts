import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { elevenLabsCallOverrides, elevenLabsLiveEndpoint } from "./live-elevenlabs.ts";
import { fishCallLanguage, fishCallSpeed, fishLiveEndpoint } from "./live-fish.ts";
import { createLiveSession, liveInstructions, LIVE_STYLE_LINE } from "./live-call.ts";
import { liveSessionWiring } from "./live-session-wiring.ts";
import { createCallVoicePreviewRoutes } from "./routes/call-voice-preview.ts";
import * as openai from "./tts/openai.ts";
import { speak } from "./tts/index.ts";
import { PASS } from "./routes/table.ts";

afterEach(() => vi.unstubAllGlobals());

const bodies = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) }));
const stubFetch = (make: () => Response) => vi.stubGlobal("fetch", vi.fn(async () => make()));
const mp3 = () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0]), { status: 200, headers: { "content-type": "audio/mpeg" } });

class FakeSocket extends EventEmitter {
  sent: Array<Record<string, any>> = [];
  constructor() { super(); queueMicrotask(() => this.emit("open")); }
  send(data: string) {
    const event = JSON.parse(data);
    this.sent.push(event);
    if (event.type === "session.update") queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })), false));
    if (event.type === "response.create") queueMicrotask(() => {
      this.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.from([0, 0, 1, 1]).toString("base64") })), false);
      this.emit("message", Buffer.from(JSON.stringify({ type: "response.done", response: { status: "completed" } })), false);
    });
  }
  terminate() {}
}

async function openaiSession(speed?: number) {
  const socket = new FakeSocket();
  await openai.synthesize("hello", "marin", "k", undefined, () => socket as unknown as WebSocket, speed);
  return socket.sent[0]!.session;
}

describe("Turns speech: speed and language per provider", () => {
  it("OpenAI Realtime takes audio.output.speed, and without a speed the payload is unchanged", async () => {
    expect((await openaiSession(1.25)).audio.output).toEqual({ format: { type: "audio/pcm", rate: 24000 }, voice: "marin", speed: 1.25 });
    expect((await openaiSession()).audio.output).toEqual({ format: { type: "audio/pcm", rate: 24000 }, voice: "marin" });
  });

  const eleven = { tts: { provider: "elevenlabs", key: "k", voice: "v1" } } as AppConfig;
  it("ElevenLabs takes voice_settings.speed clamped to its range and language_code", async () => {
    stubFetch(mp3);
    await speak(eleven, "hello", undefined, undefined, undefined, { speed: 1.8, language: "pt-BR" });
    expect(bodies()[0]!.body).toEqual({ text: "hello", model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.2 }, language_code: "pt" });
  });
  it("ElevenLabs without speed or language sends only text and model", async () => {
    stubFetch(mp3);
    await speak(eleven, "hello", undefined, undefined, undefined, { language: "auto", speed: "fast" });
    expect(bodies()[0]!.body).toEqual({ text: "hello", model_id: "eleven_flash_v2_5" });
  });

  const fish = { tts: { provider: "fish", fishKey: "k", voice: "v1" } } as AppConfig;
  it("Fish takes prosody.speed, and none without a speed", async () => {
    stubFetch(mp3);
    await speak(fish, "hello", undefined, undefined, undefined, { speed: 0.5, language: "fr" });
    expect(bodies()[0]!.body.prosody).toEqual({ speed: 0.5 });
    expect(bodies()[0]!.body.language).toBeUndefined();
    stubFetch(mp3);
    await speak(fish, "hello");
    expect(bodies()[0]!.body.prosody).toBeUndefined();
  });

  const xai = { xai: { key: "k" }, tts: { provider: "xai", voice: "ara" } } as AppConfig;
  it("xAI takes speed and language, and keeps language auto without one", async () => {
    stubFetch(mp3);
    await speak(xai, "hello", undefined, undefined, undefined, { speed: 2, language: "ja" });
    expect(bodies()[0]!.body).toMatchObject({ speed: 1.5, language: "ja" });
    stubFetch(mp3);
    await speak(xai, "hello");
    expect(bodies()[0]!.body).toEqual({ text: "hello", voice_id: "ara", language: "auto", output_format: { codec: "mp3" } });
  });

  it("Gemini and Chatterbox send nothing new", async () => {
    stubFetch(() => new Response("{}", { status: 500 }));
    await speak({ tts: { provider: "gemini", geminiKey: "k", voice: "Puck" } } as AppConfig, "hello", undefined, undefined, undefined, { speed: 1.4, language: "fr" }).catch(() => undefined);
    await speak({ tts: { provider: "chatterbox", baseUrl: "http://127.0.0.1:9", voice: "default" } } as AppConfig, "hello", undefined, undefined, undefined, { speed: 1.4, language: "fr" }).catch(() => undefined);
    for (const { body } of bodies()) expect(JSON.stringify(body)).not.toMatch(/speed|language|fr/);
  });
});

describe("Live session config", () => {
  const BOT = { name: "Ada" };
  const make = async (extra: Record<string, unknown>, provider: "openai" | "custom" = "openai") => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ session: { id: "s" }, transport: { sdp: "v=0" } }), { status: 201 }));
    await createLiveSession({ key: "k", sdp: "v=0\r\n", bot: BOT, history: [], cloudHome: false, voice: "cedar", fetchImpl: fetchImpl as unknown as typeof fetch,
      endpoint: { provider, apiBase: "https://x.test/v1", model: "m" }, ...extra });
    return JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).session;
  };

  it("sends audio.output.speed only when it differs from 1, clamped to the provider range", async () => {
    expect((await make({ callSpeed: 1.15 })).audio.output).toEqual({ voice: "cedar", speed: 1.15 });
    expect((await make({ callSpeed: 2 })).audio.output.speed).toBe(1.5);
    expect((await make({ callSpeed: 1 })).audio.output).toEqual({ voice: "cedar" });
    expect((await make({})).audio.output).toEqual({ voice: "cedar" });
  });
  it("sends no speed to a custom server", async () => {
    expect((await make({ callSpeed: 1.3 }, "custom")).audio.output).toEqual({ voice: "cedar" });
  });
  it("puts the chosen language in the instructions in place of the default line", async () => {
    const chosen = (await make({ callLanguage: "id" })).instructions as string;
    expect(chosen).toContain("Speak Indonesian for the whole call, even when the person uses another language.");
    expect(chosen).not.toContain("Speak the language the user speaks.");
    for (const callLanguage of [undefined, "auto"]) expect((await make({ callLanguage })).instructions).toContain(LIVE_STYLE_LINE);
    expect(liveInstructions(BOT)).toBe((await make({})).instructions);
  });
});

describe("ElevenLabs call overrides", () => {
  it("builds them only from what the bot saved", () => {
    expect(elevenLabsCallOverrides(undefined, undefined)).toBeUndefined();
    expect(elevenLabsCallOverrides(undefined, "auto")).toBeUndefined();
    expect(elevenLabsCallOverrides(1.5, "pt-BR")).toEqual({ tts: { speed: 1.2 }, agent: { language: "pt" } });
  });

  const wire = (allow: number) => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "PATCH") return new Response("{}", { status: allow });
      return new Response(JSON.stringify({ signed_url: "wss://x.test/c" }), { status: 200 });
    });
    const wiring = liveSessionWiring({ bot: () => ({ name: "Ada" }), history: () => [], cloudHome: false, othersOnLoopback: () => false, saveAgent: () => {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    return { calls, wiring };
  };
  const start = (extra: Record<string, unknown>) => ({ key: "k", sdp: "", botId: "b", threadId: "t", voice: "agent", endpoint: elevenLabsLiveEndpoint("agent_1", {}), ...extra });

  it("allows the overrides once, then sends speed and language with the session", async () => {
    const { calls, wiring } = wire(200);
    const first = await wiring.calls.createSession(start({ callSpeed: 1.1, callLanguage: "id" })) as any;
    await wiring.calls.createSession(start({ callSpeed: 1.1 }));
    expect(first.elevenlabs.session.overrides).toEqual({ tts: { speed: 1.1 }, agent: { language: "id" } });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body.platform_settings.overrides.conversation_config_override).toMatchObject({ tts: { speed: true }, agent: { language: true } });
    expect(patches[0]!.body.platform_settings.auth).toEqual({ enable_auth: true });
  });
  it("sends nothing extra without a saved speed or language", async () => {
    const { calls, wiring } = wire(200);
    const answer = await wiring.calls.createSession(start({})) as any;
    expect(answer.elevenlabs.session.overrides).toBeUndefined();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
  it("starts the call without overrides and warns once when they cannot be allowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wiring } = wire(403);
    const answer = await wiring.calls.createSession(start({ callSpeed: 1.1 })) as any;
    expect(answer.elevenlabs.session.overrides).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("Fish call speed and language", () => {
  it("maps the saved values to what Fish takes", () => {
    expect(fishCallSpeed(3 as never)).toBe(1);
    expect(fishCallSpeed(0.5)).toBe(0.5);
    expect(fishCallLanguage("pt-BR")).toBe("pt");
    expect(fishCallLanguage("jv")).toBeUndefined();
    expect(fishCallLanguage("auto")).toBeUndefined();
  });

  const wire = (saved?: number) => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("https://api.fish.audio/v1/agent", "");
      calls.push({ method: init!.method!, path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === "/sessions") return new Response(JSON.stringify({ transport: "livekit", session_id: "s", livekit_url: "wss://x.test", token: "t" }), { status: 201 });
      return new Response("{}", { status: 200 });
    });
    const live: { fishAgentSpeed?: number } = { fishAgentSpeed: saved };
    const wiring = liveSessionWiring({
      bot: () => ({ name: "Ada" }), history: () => [], cloudHome: false, othersOnLoopback: () => false,
      saveAgent: (agent) => { if ("fishAgentSpeed" in agent) live.fishAgentSpeed = agent.fishAgentSpeed; },
      fishAgentSpeed: () => live.fishAgentSpeed, fetchImpl: fetchImpl as unknown as typeof fetch, env: {},
    });
    return { calls, wiring };
  };
  const start = (extra: Record<string, unknown>) => ({ key: "k", sdp: "", botId: "b", threadId: "t", voice: "agent", endpoint: fishLiveEndpoint("agent_1", {}), ...extra });
  const patches = (calls: Array<{ method: string; body: any }>) => calls.filter((c) => c.method === "PATCH").map((c) => c.body);

  it("patches the agent speed only when it differs from the last value the server set", async () => {
    const { calls, wiring } = wire();
    await wiring.calls.createSession(start({ callSpeed: 1.4 }));
    await wiring.calls.createSession(start({ callSpeed: 1.4 }));
    expect(patches(calls)).toEqual([{ voice: { speed: 1.4 } }]);
    await wiring.calls.createSession(start({}));
    expect(patches(calls)).toEqual([{ voice: { speed: 1.4 } }, { voice: { speed: 1 } }]);
    await wiring.calls.createSession(start({}));
    expect(patches(calls)).toHaveLength(2);
  });
  it("sets a bot without a saved speed back to 1 after a saved 1.5, and not again", async () => {
    const { calls, wiring } = wire(1.5);
    await wiring.calls.createSession(start({}));
    expect(patches(calls)).toEqual([{ voice: { speed: 1 } }]);
    await wiring.calls.createSession(start({}));
    expect(patches(calls)).toHaveLength(1);
  });
  it("sends no patch when the persisted speed is the same", async () => {
    const { calls, wiring } = wire(1.5);
    await wiring.calls.createSession(start({ callSpeed: 1.5 }));
    expect(patches(calls)).toEqual([]);
  });
  it("does not patch an agent when the bot has no saved speed", async () => {
    const { calls, wiring } = wire();
    await wiring.calls.createSession(start({}));
    expect(patches(calls)).toEqual([]);
  });
  it("uses the bot's language in place of the app's", async () => {
    const { calls, wiring } = wire();
    await wiring.calls.createSession(start({ callLanguage: "de" }));
    expect(patches(calls)).toEqual([{ voice: { speaking_language: "de" } }]);
  });
});

describe("POST /api/call/voice-preview", () => {
  async function call(body: unknown, cfg: AppConfig = {} as AppConfig, method = "POST") {
    const answers: Array<[number, any]> = [];
    const written: { status?: number; headers?: Record<string, string>; bytes?: Buffer } = {};
    const handlers: Record<string, () => void> = {};
    const res = {
      writableEnded: false,
      on: (event: string, fn: () => void) => { handlers[event] = fn; }, off() {},
      writeHead: (status: number, headers: Record<string, string>) => { written.status = status; written.headers = headers; },
      end: (bytes: Buffer) => { written.bytes = bytes; },
    };
    const out = await createCallVoicePreviewRoutes({ config: () => cfg })({
      req: {} as never, res: res as never, url: new URL("http://x/api/call/voice-preview"), path: "/api/call/voice-preview", method,
      auth: { kind: "loopback", scopes: ["client"] },
      json: ((_r: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never, readBody: (async () => body) as never,
    });
    return { out, answers, written, handlers };
  }
  const ok = { provider: "gemini", voice: "Kore", text: "Hello there" };
  const gemini = { tts: { geminiKey: "k" } } as AppConfig;

  it("leaves other paths and methods alone", async () => {
    expect((await call(ok, gemini, "GET")).out).toBe(PASS);
  });
  it("answers 400 for an unknown provider, empty or long text, a bad speed or a voice the provider lacks", async () => {
    const bad: unknown[] = [
      { ...ok, provider: "nope" }, { ...ok, text: " " }, { ...ok, text: "a".repeat(201) }, { ...ok, speed: 3 }, { ...ok, speed: "1" },
      { ...ok, voice: "marin" }, { provider: "openai", voice: "Kore", text: "Hi" },
    ];
    for (const body of bad) expect((await call(body, gemini)).answers[0]![0], JSON.stringify(body)).toBe(400);
  });
  it("answers 404 for ElevenLabs, Fish, Codex and a missing key or a voice the Turns path lacks", async () => {
    for (const provider of ["elevenlabs", "fish", "codex"]) expect((await call({ ...ok, provider }, gemini)).answers[0]![0]).toBe(404);
    expect((await call(ok, {} as AppConfig)).answers[0]![0]).toBe(404);
    expect((await call({ provider: "openai", voice: "marin", text: "Hi" }, {} as AppConfig)).answers[0]![0]).toBe(404);
    expect((await call({ provider: "openai", voice: "gleam", text: "Hi" }, { openai: { key: "k" } } as AppConfig)).answers[0]![0]).toBe(404);
  });
  it("never sends a Live key saved for Azure or a custom gateway to OpenAI", async () => {
    stubFetch(mp3);
    const spy = vi.spyOn(openai, "synthesize");
    for (const provider of ["azure", "custom"] as const) {
      const cfg = { live: { provider, key: "live-secret", keyFor: `${provider}:gw.example`, [provider === "azure" ? "azureEndpoint" : "customEndpoint"]: `https://gw.example` } } as AppConfig;
      expect((await call({ provider, voice: "cedar", text: "Hi" }, cfg)).answers[0]![0]).toBe(404);
    }
    const openaiLive = { live: { key: "live-secret", keyFor: "openai" } } as AppConfig;
    expect((await call({ provider: "azure", voice: "cedar", text: "Hi" }, openaiLive)).answers[0]![0]).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("speaks a Gemini voice and answers audio that is never cached", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(40)]);
    stubFetch(() => new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "audio", data: wav.toString("base64"), mime_type: "audio/wav" }] }] }), { status: 200 }));
    const { written, answers } = await call(ok, gemini);
    expect(answers).toEqual([]);
    expect(written.status).toBe(200);
    expect(written.headers).toMatchObject({ "content-type": "audio/wav", "cache-control": "no-store" });
    expect(written.bytes!.equals(wav)).toBe(true);
    expect(bodies()[0]!.body.generation_config).toEqual({ speech_config: [{ voice: "Kore" }] });
  });
  it("speaks an OpenAI voice at the chosen speed for OpenAI, Azure and custom calls", async () => {
    const sockets: FakeSocket[] = [];
    const spy = vi.spyOn(openai, "synthesize").mockImplementation(async (_t, _v, _k, _s, _c, speed) => {
      sockets.push({ sent: [{ speed }] } as never);
      return { bytes: new Uint8Array([1, 2]), mime: "audio/wav" };
    });
    for (const provider of ["openai", "azure", "custom"]) {
      const { written } = await call({ provider, voice: "cedar", text: "Hi", speed: 1.3 }, { openai: { key: "k" } } as AppConfig);
      expect(written.status).toBe(200);
      expect(written.headers!["content-type"]).toBe("audio/wav");
    }
    expect(spy.mock.calls.map((c) => c[5])).toEqual([1.3, 1.3, 1.3]);
    spy.mockRestore();
  });
});
