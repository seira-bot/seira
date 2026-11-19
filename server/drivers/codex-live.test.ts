import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineLiveVoiceError, type EngineLiveVoiceEvent, type EngineLiveVoiceSession, type EngineLiveVoiceStart, type ProviderInstance } from "../contracts.ts";
import { DATA_DIR } from "../config.ts";
import { codexLiveEndpoint } from "../live-call.ts";
import { liveSessionWiring } from "../live-session-wiring.ts";
import { setNativeSkillEnabled } from "../native-skill-choices.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDriver } from "./codex.ts";
import { decodeCodexSelection, encodeCodexSelection } from "./codex-catalog.ts";
import { codexTurnConfigArgs } from "./codex-guest.ts";
import { codexLiveAppServerArgs, codexOwnLoginArgs } from "./codex-own-login-args.ts";
import { codexLiveVoice, codexVersionTooOld, type CodexLiveDeps, type CodexLiveTimeouts, type LiveCodexChild } from "./codex-live.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const FAKE_SDP_ANSWER = "v=0\r\no=fake-codex-answer\r\ns=-\r\nt=0 0\r\n";
const MODERN = "codex-cli 0.170.0";

const baseEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("FAKE_CODEX_")));

const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const isGone = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

let scratch: string;
let counter = 0;
const toStop: Array<{ stop(): Promise<void> }> = [];

beforeEach(() => {
  chmodSync(FAKE, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "omb-codex-live-"));
});

afterEach(async () => {
  await Promise.all(toStop.splice(0).map((session) => session.stop()));
  await removeTempDir(scratch);
});

function workspaceParams(mode: string) {
  const approvalsReviewer = mode === "auto" ? "auto_review" : "user";
  return {
    thread: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer },
    turn: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" }, approvalsReviewer },
  };
}

function resolveLike(params: { thread: Record<string, unknown>; turn: Record<string, unknown> }, session: any) {
  const type = (params.turn.sandboxPolicy as { type: string }).type;
  if (typeof session?.sandbox?.type !== "string" || session.sandbox.type !== type) throw new Error("sandbox");
  return params;
}

interface Harness {
  live: ReturnType<typeof codexLiveVoice>;
  logs: string[];
  events: EngineLiveVoiceEvent[];
  spawned: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined>; child: LiveCodexChild }>;
  dump: string;
  calls(): Array<{ method: string; params: any }>;
  decision(): unknown;
  input(overrides?: Partial<EngineLiveVoiceStart>): EngineLiveVoiceStart;
  start(overrides?: Partial<EngineLiveVoiceStart>): Promise<EngineLiveVoiceSession>;
}

function harness(options: { fake?: Record<string, string>; timeouts?: Partial<CodexLiveTimeouts>; deps?: Partial<CodexLiveDeps>; version?: string | null } = {}): Harness {
  const dump = join(scratch, `dump-${counter++}.json`);
  const logs: string[] = [];
  const events: EngineLiveVoiceEvent[] = [];
  const spawned: Harness["spawned"] = [];
  const fakeEnv = { ...baseEnv(), ...options.fake, FAKE_CODEX_DUMP: dump };
  const live = codexLiveVoice({
    unsupportedSignIn: false,
    env: () => fakeEnv,
    version: async () => options.version === undefined ? MODERN : options.version,
    approvalParams: (mode) => workspaceParams(mode),
    permissionProfileUnsupported: (error) => /experimental api|unknown field/i.test(error instanceof Error ? error.message : String(error)),
    withResolvedSandbox: resolveLike,
    spawn: (args, spawnOptions) => {
      const child = spawn(process.execPath, [FAKE, ...args], { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["pipe", "pipe", "pipe"] });
      spawned.push({ args, cwd: spawnOptions.cwd, env: spawnOptions.env, child });
      return child;
    },
    clientVersion: "0.0.0-test",
    log: (line) => logs.push(line),
    timeouts: { answerMs: 5_000, stopMs: 2_000, killMs: 2_000, approvalMs: 60_000, rpcMs: 5_000, settleMs: 50,
      spokenCharsPerSecond: Number.POSITIVE_INFINITY, echoTailMs: 20, ...options.timeouts },
    ...options.deps,
  });
  const read = () => (existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) : { calls: [], decision: null });
  const input = (overrides: Partial<EngineLiveVoiceStart> = {}): EngineLiveVoiceStart => ({
    sdp: "offer-sdp",
    cwd: scratch,
    botId: "bot-live",
    model: null,
    approvalMode: "ask",
    voiceInstructions: "Be brief.",
    workInstructions: "Do the work.",
    history: [{ role: "user", text: "hi" }, { role: "assistant", text: "" }, { role: "assistant", text: "hello" }],
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return {
    live, logs, events, spawned, dump, input,
    calls: () => read().calls,
    decision: () => read().decision,
    start: async (overrides) => {
      const session = await live.start(input(overrides));
      toStop.push(session);
      return session;
    },
  };
}

const refusalOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (reason) => reason);
  expect(error).toBeInstanceOf(EngineLiveVoiceError);
  return (error as EngineLiveVoiceError).refusal;
};

describe("codexVersionTooOld", () => {
  it("compares against 0.170.0 and continues when the version is unknown", () => {
    expect(codexVersionTooOld("codex-cli 0.169.0")).toBe(true);
    expect(codexVersionTooOld("codex-cli 0.99.9")).toBe(true);
    expect(codexVersionTooOld("codex-cli 0.170.0")).toBe(false);
    expect(codexVersionTooOld("0.170.1")).toBe(false);
    expect(codexVersionTooOld("codex-cli 1.0.0")).toBe(false);
    expect(codexVersionTooOld(null)).toBe(false);
    expect(codexVersionTooOld("unknown build")).toBe(false);
  });
});

describe("codexLiveVoice sign-in checks", () => {
  it.each(["apikey", "none"])("refuses a %s account as not signed in and ends the process", async (account) => {
    const h = harness({ fake: { FAKE_CODEX_ACCOUNT: account } });
    expect(await refusalOf(h.live.start(h.input()))).toBe("not-signed-in");
    expect(h.spawned).toHaveLength(1);
    expect(isGone(h.spawned[0]!.child)).toBe(true);
    expect(h.calls().map((call) => call.method)).not.toContain("thread/realtime/start");
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/^live codex: refused not-signed-in ms=\d+ init=\d+ account=\d+ thread=0 answer=0$/);
  });

  it("refuses an old Codex before it reads the account, and ends the process", async () => {
    const readVersion = (env: Record<string, string>) => execFileSync(process.execPath, [FAKE, "--version"], { env: { ...baseEnv(), ...env } as NodeJS.ProcessEnv }).toString();
    const h = harness({ deps: { version: async () => readVersion({ FAKE_CODEX_VERSION: "codex-cli 0.169.0" }) } });
    expect(await refusalOf(h.live.start(h.input()))).toBe("too-old");
    expect(h.spawned).toHaveLength(1);
    expect(isGone(h.spawned[0]!.child)).toBe(true);
    const methods = h.calls().map((call) => call.method);
    expect(methods).not.toContain("account/read");
    expect(methods).not.toContain("thread/start");
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/^live codex: refused too-old ms=\d+ /);
  });

  it("refuses an old Codex as too-old, not failed, when the process dies at once", async () => {
    const h = harness({
      version: "codex-cli 0.169.0",
      deps: { spawn: (_args, options) => spawn(process.execPath, ["-e", "process.exit(3)"], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] }) },
    });
    expect(await refusalOf(h.live.start(h.input()))).toBe("too-old");
  });

  it("refuses an old Codex as too-old when the process cannot start", async () => {
    const h = harness({ version: "codex-cli 0.169.0", deps: { spawn: () => { throw new Error("ENOENT"); } } });
    expect(await refusalOf(h.live.start(h.input()))).toBe("too-old");
  });

  it("continues when the version is unknown", async () => {
    const h = harness({ version: null });
    const session = await h.start();
    expect(session.sdp).toBe(FAKE_SDP_ANSWER);
  });

  it("refuses the Seira plan token, an endpoint and a managed key without a spawn", async () => {
    const h = harness({ deps: { unsupportedSignIn: true } });
    expect(await refusalOf(h.live.start(h.input()))).toBe("unsupported-sign-in");
    expect(h.spawned).toHaveLength(0);
  });
});

describe("codexLiveVoice start", () => {
  it("starts the realtime session with every field and returns the answer unchanged", async () => {
    const h = harness();
    const session = await h.start({ cwd: scratch, approvalMode: "auto" });
    expect(session.sdp).toBe(FAKE_SDP_ANSWER);
    expect(h.spawned[0]!.args[0]).toBe("app-server");
    const calls = h.calls();
    const methods = calls.map((call) => call.method);
    expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "account/read"]);
    expect(calls[0]!.params.capabilities).toEqual({ experimentalApi: true });
    expect(calls[2]!.params).toEqual({ refreshToken: false });
    expect(methods.indexOf("thread/start")).toBeLessThan(methods.indexOf("thread/realtime/start"));
    expect(calls.find((call) => call.method === "thread/start")!.params).toEqual({
      cwd: scratch, approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review", ephemeral: false,
    });
    expect(calls.find((call) => call.method === "thread/realtime/start")!.params).toEqual({
      threadId: "codex-thread-1",
      outputModality: "audio",
      includeStartupContext: false,
      transport: { type: "webrtc", sdp: "offer-sdp" },
      version: "v3",
      realtimeSessionId: "codex-thread-1",
      initialItems: [{ role: "developer", text: "Be brief." }, { role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
      realtimeStartInstructions: "Do the work.",
    });
    await until(() => h.events.some((event) => event.type === "started"));
  });

  it("leaves out the work instructions and the developer item when they are empty", async () => {
    const h = harness();
    await h.start({ workInstructions: "  ", voiceInstructions: "", history: [] });
    const params = h.calls().find((call) => call.method === "thread/realtime/start")!.params;
    expect(params.initialItems).toEqual([]);
    expect("realtimeStartInstructions" in params).toBe(false);
    expect("prompt" in params).toBe(false);
  });

  it("asks for the effective config only in the custom mode", async () => {
    const seen: unknown[] = [];
    const h = harness({ deps: { approvalParams: (mode, config) => { seen.push([mode, config]); return workspaceParams(mode); } } });
    await h.start({ approvalMode: "custom" });
    expect(h.calls().map((call) => call.method)).toContain("config/read");
    expect(seen).toHaveLength(1);
    expect((seen[0] as unknown[])[0]).toBe("custom");
    expect((seen[0] as unknown[])[1]).toBeTypeOf("object");
  });

  it("refuses with no-answer when no SDP comes, and ends the process", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "silent" }, timeouts: { answerMs: 150 } });
    const started = Date.now();
    expect(await refusalOf(h.live.start(h.input()))).toBe("no-answer");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(isGone(h.spawned[0]!.child)).toBe(true);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/^live codex: refused no-answer ms=\d+ init=\d+ account=\d+ thread=\d+ answer=\d+$/);
  });

  it("refuses with failed when the process cannot start or dies early", async () => {
    const cannotStart = harness({ deps: { spawn: () => { throw new Error("ENOENT"); } } });
    expect(await refusalOf(cannotStart.live.start(cannotStart.input()))).toBe("failed");

    const rejected = harness({ fake: { FAKE_CODEX_START_ERROR: JSON.stringify({ code: -32600, message: "no thread" }) } });
    expect(await refusalOf(rejected.live.start(rejected.input()))).toBe("failed");
    expect(isGone(rejected.spawned[0]!.child)).toBe(true);

    const dies = harness({ deps: { spawn: (_args, options) =>
      spawn(process.execPath, ["-e", "process.exit(3)"], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] }) } });
    expect(await refusalOf(dies.live.start(dies.input()))).toBe("failed");
  });

  it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const stubborn = "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);";
    const spawned: ChildProcess[] = [];
    const h = harness({ timeouts: { rpcMs: 100, killMs: 150 }, deps: { spawn: (_args, options) => {
      const child = spawn(process.execPath, ["-e", stubborn], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
      spawned.push(child);
      return child;
    } } });
    const started = Date.now();
    expect(await refusalOf(h.live.start(h.input()))).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(() => isGone(spawned[0]!));
    expect(spawned[0]!.signalCode).toBe("SIGKILL");
  });
});

describe("codexLiveVoice start timing", () => {
  const spyOnRequests = (methods: string[]): Partial<CodexLiveDeps> => ({
    spawn: (args, spawnOptions) => {
      const child = spawn(process.execPath, [FAKE, ...args], { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["pipe", "pipe", "pipe"] });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
        try { methods.push(JSON.parse(String(chunk)).method); } catch { /* not a request */ }
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof child.stdin.write;
      return child;
    },
  });

  it("reads the version while the process starts, and holds the account read until the version is known", async () => {
    const order: string[] = [];
    const methods: string[] = [];
    let release!: (value: string) => void;
    const known = new Promise<string>((resolve) => { release = resolve; });
    const h = harness({ deps: {
      version: () => { order.push("version"); return known; },
      ...spyOnRequests(methods),
      spawn: (args, spawnOptions) => { order.push("spawn"); return spyOnRequests(methods).spawn!(args, spawnOptions); },
    } });
    const starting = h.start();
    await until(() => methods.includes("initialized"));
    expect(order).toEqual(["version", "spawn"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(methods).not.toContain("account/read");
    release(MODERN);
    await starting;
    expect(methods).toContain("account/read");
  });

  it("sends the account read and the config read together in the custom mode", async () => {
    const methods: string[] = [];
    const h = harness({ fake: { FAKE_CODEX_ACCOUNT_MODE: "hang" }, deps: spyOnRequests(methods) });
    const abort = new AbortController();
    const refused = refusalOf(h.live.start(h.input({ approvalMode: "custom", signal: abort.signal })));
    await until(() => methods.includes("account/read") && methods.includes("config/read"));
    abort.abort();
    expect(await refused).toBe("failed");
  });

  it("never starts a thread for an account that is not signed in, even in the custom mode", async () => {
    const methods: string[] = [];
    const h = harness({ fake: { FAKE_CODEX_ACCOUNT: "none" }, deps: spyOnRequests(methods) });
    expect(await refusalOf(h.live.start(h.input({ approvalMode: "custom" })))).toBe("not-signed-in");
    expect(methods).not.toContain("thread/start");
  });

  it("logs the time of each phase", async () => {
    let tick = 0;
    const h = harness({ deps: { now: () => (tick += 10) } });
    await h.start();
    expect(h.logs).toEqual(["live codex: started ms=40 init=10 account=10 thread=10 answer=10"]);
  });

  it("logs the phases reached when a start fails", async () => {
    let tick = 0;
    const h = harness({ fake: { FAKE_CODEX_ACCOUNT: "none" }, deps: { now: () => (tick += 10) } });
    await refusalOf(h.live.start(h.input()));
    expect(h.logs).toEqual(["live codex: refused not-signed-in ms=20 init=10 account=10 thread=0 answer=0"]);
  });
});

describe("codexLiveVoice limits of the bot", () => {
  const skill = () => join(process.env.HOME!, ".agents", "skills", "pdf", "SKILL.md");
  afterEach(() => {
    rmSync(join(process.env.HOME!, ".agents"), { recursive: true, force: true });
    rmSync(join(DATA_DIR, "skill-state"), { recursive: true, force: true });
  });

  it("starts the app-server with the tool limits and the skill switches of the bot", async () => {
    mkdirSync(dirname(skill()), { recursive: true });
    writeFileSync(skill(), "---\nname: pdf\ndescription: PDFs.\n---\nSteps.\n");
    setNativeSkillEnabled("bot-live", "pdf", false);
    const h = harness();
    await h.start();
    const args = h.spawned[0]!.args;
    expect(args[0]).toBe("app-server");
    for (const setting of ["features.plugins=false", "features.computer_use=false", "features.browser_use=false", "features.browser_use_external=false"]) {
      expect(args.slice(1).filter((arg, index, all) => arg === setting && all[index - 1] === "-c")).toHaveLength(1);
    }
    expect(args.find((arg) => arg.startsWith("skills.config="))).toContain(`{path=${JSON.stringify(skill())},enabled=false}`);
    const other = harness();
    await other.start({ botId: "bot-without-switches" });
    expect(other.spawned[0]!.args.some((arg) => arg.startsWith("skills.config="))).toBe(false);
  });

  it("builds the arguments with the function that chat turns use, from the environment the process gets", async () => {
    const model = encodeCodexSelection("magpie", "local-model");
    const h = harness();
    await h.start({ model });
    const spawnedEnv = h.spawned[0]!.env;
    expect(h.spawned[0]!.args).toEqual(["app-server", ...codexOwnLoginArgs(spawnedEnv, model, codexTurnConfigArgs({ botId: "bot-live" }, spawnedEnv))]);
    expect(h.spawned[0]!.args).toContain('model_provider="magpie"');
  });

  it("starts the thread on the model and provider of the bot, decoded as chat decodes them", async () => {
    const model = encodeCodexSelection("magpie", "local-model");
    const h = harness();
    await h.start({ model });
    expect(h.calls().find((call) => call.method === "thread/start")!.params).toMatchObject({ model: "local-model", modelProvider: "magpie" });
    const official = harness();
    await official.start({ model: "gpt-5.5" });
    const decoded = decodeCodexSelection("gpt-5.5");
    expect(official.calls().find((call) => call.method === "thread/start")!.params).toMatchObject({ model: decoded.model, modelProvider: decoded.modelProvider });
    const none = harness();
    await none.start({ model: null });
    expect(none.calls().find((call) => call.method === "thread/start")!.params).not.toHaveProperty("model");
    expect(none.calls().find((call) => call.method === "thread/start")!.params).not.toHaveProperty("modelProvider");
  });
});

describe("codexLiveVoice close before the answer", () => {
  it.each([["closed-early", "closed"], ["error-early", "error"]])("refuses at once when Codex ends the call with %s before the answer", async (mode) => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: mode }, timeouts: { answerMs: 30_000 } });
    const started = Date.now();
    expect(await refusalOf(h.live.start(h.input()))).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(isGone(h.spawned[0]!.child)).toBe(true);
    expect(h.events).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/^live codex: refused failed ms=\d+ init=\d+ account=\d+ thread=\d+ answer=\d+$/);
  });

  it("refuses well before the wait for the answer ends, with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      let emitLine!: (line: string) => void;
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(chunk, _enc, done) { sent.push(String(chunk)); done(); } }),
        stdout,
        stderr: new PassThrough(),
        kill: () => { child.emit("exit", 0, null); return true; },
      }) as unknown as LiveCodexChild;
      emitLine = (line) => { stdout.write(`${line}\n`); };
      const logs: string[] = [];
      const live = codexLiveVoice({
        unsupportedSignIn: false, env: () => ({}), version: async () => MODERN,
        approvalParams: (mode) => workspaceParams(mode), permissionProfileUnsupported: () => false, withResolvedSandbox: resolveLike,
        spawn: () => child, clientVersion: "0.0.0-test", log: (line) => logs.push(line),
        timeouts: { answerMs: 20_000, stopMs: 100, killMs: 100, approvalMs: 60_000, rpcMs: 20_000 },
      });
      const starting = live.start({ sdp: "offer", cwd: "/work", botId: "b", model: null, approvalMode: "ask", voiceInstructions: "", workInstructions: "", history: [], onEvent: () => {} });
      const failure = starting.then(() => null, (error) => error);
      const reply = async (method: string, result: unknown) => {
        await vi.waitFor(() => expect(sent.some((line) => JSON.parse(line).method === method)).toBe(true));
        const id = JSON.parse(sent.find((line) => JSON.parse(line).method === method)!).id;
        emitLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      await reply("initialize", {});
      await reply("account/read", { account: { type: "chatgpt" } });
      await reply("thread/start", { thread: { id: "t1" }, sandbox: { type: "workspaceWrite" } });
      await vi.waitFor(() => expect(sent.some((line) => JSON.parse(line).method === "thread/realtime/start")).toBe(true));
      emitLine(JSON.stringify({ jsonrpc: "2.0", method: "thread/realtime/closed", params: { threadId: "t1", reason: "quota" } }));
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await failure;
      expect(error).toBeInstanceOf(EngineLiveVoiceError);
      expect((error as EngineLiveVoiceError).refusal).toBe("failed");
      expect(logs.at(-1)).toMatch(/^live codex: refused failed ms=\d+ /);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("codexLiveVoice scripted process", () => {
  function scripted(over: Partial<CodexLiveDeps> = {}) {
    const sent: string[] = [];
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(chunk, _enc, done) { sent.push(String(chunk)); done(); } }),
      stdout,
      stderr: new PassThrough(),
      kill: () => { child.emit("exit", 0, null); return true; },
    }) as unknown as LiveCodexChild;
    const logs: string[] = [];
    const live = codexLiveVoice({
      unsupportedSignIn: false, env: () => ({}), version: async () => MODERN,
      approvalParams: (mode) => workspaceParams(mode), permissionProfileUnsupported: () => false, withResolvedSandbox: resolveLike,
      spawn: () => child, clientVersion: "0.0.0-test", log: (line) => logs.push(line),
      timeouts: { answerMs: 20_000, stopMs: 100, killMs: 100, approvalMs: 60_000, rpcMs: 20_000 },
      ...over,
    });
    const line = (message: unknown) => { stdout.write(`${JSON.stringify(message)}\n`); };
    const requestsOf = (method: string) => sent.map((text) => JSON.parse(text)).filter((message) => message.method === method);
    const reply = async (method: string, result: unknown) => {
      await vi.waitFor(() => expect(requestsOf(method)).toHaveLength(1));
      line({ jsonrpc: "2.0", id: requestsOf(method)[0].id, result });
    };
    const input = (extra: Partial<EngineLiveVoiceStart> = {}): EngineLiveVoiceStart => ({
      sdp: "offer", cwd: "/work", botId: "b", model: null, approvalMode: "ask", voiceInstructions: "", workInstructions: "", history: [], onEvent: () => {}, ...extra,
    });
    const toRealtimeStart = async () => {
      await reply("initialize", {});
      await reply("account/read", { account: { type: "chatgpt" } });
      await reply("thread/start", { thread: { id: "t1" }, sandbox: { type: "workspaceWrite" } });
      await vi.waitFor(() => expect(requestsOf("thread/realtime/start")).toHaveLength(1));
    };
    return { live, logs, line, requestsOf, reply, input, toRealtimeStart, child };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("ends the process and refuses at once when the call ends while it waits for the answer", async () => {
    const p = scripted();
    const abort = new AbortController();
    const failure = p.live.start(p.input({ signal: abort.signal })).then(() => null, (error) => error);
    await p.toRealtimeStart();
    const exited = vi.fn();
    p.child.on("exit", exited);
    abort.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await failure;
    expect(error).toBeInstanceOf(EngineLiveVoiceError);
    expect((error as EngineLiveVoiceError).refusal).toBe("failed");
    expect(exited).toHaveBeenCalled();
    expect(p.logs.some((line) => line.startsWith("live codex: started"))).toBe(false);
  });

  it("ends the process when the call ends before the account read answers", async () => {
    const p = scripted();
    const abort = new AbortController();
    const failure = p.live.start(p.input({ signal: abort.signal })).then(() => null, (error) => error);
    await p.reply("initialize", {});
    const exited = vi.fn();
    p.child.on("exit", exited);
    abort.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(((await failure) as EngineLiveVoiceError).refusal).toBe("failed");
    expect(exited).toHaveBeenCalled();
  });

  it("starts no process when the call has already ended", async () => {
    const spawned = vi.fn();
    const p = scripted({ spawn: spawned });
    const abort = new AbortController();
    abort.abort();
    expect(await refusalOf(p.live.start(p.input({ signal: abort.signal })))).toBe("failed");
    expect(spawned).not.toHaveBeenCalled();
  });

  it("refuses when the call ends after the answer came but before the start returned", async () => {
    const p = scripted();
    const abort = new AbortController();
    const failure = p.live.start(p.input({ signal: abort.signal })).then(() => null, (error) => error);
    await p.toRealtimeStart();
    abort.abort();
    p.line({ jsonrpc: "2.0", method: "thread/realtime/sdp", params: { threadId: "t1", sdp: "answer" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(((await failure) as EngineLiveVoiceError).refusal).toBe("failed");
    expect(p.logs.some((line) => line.startsWith("live codex: started"))).toBe(false);
  });

  it("refuses an answer that arrives after dispose began, and reports no started call", async () => {
    const p = scripted();
    const failure = p.live.start(p.input()).then(() => null, (error) => error);
    await p.toRealtimeStart();
    const disposing = p.live.dispose();
    p.line({ jsonrpc: "2.0", method: "thread/realtime/sdp", params: { threadId: "t1", sdp: "late answer" } });
    await vi.advanceTimersByTimeAsync(1_000);
    await disposing;
    expect(((await failure) as EngineLiveVoiceError).refusal).toBe("failed");
    expect(p.logs.some((line) => line.startsWith("live codex: started"))).toBe(false);
  });

  it("runs one stop when a listener of the final failed event stops the session again", async () => {
    const p = scripted();
    let session!: EngineLiveVoiceSession;
    const events: EngineLiveVoiceEvent[] = [];
    const starting = p.live.start(p.input({ onEvent: (event) => { events.push(event); if (event.type === "failed") void session.stop(); } }));
    await p.toRealtimeStart();
    p.line({ jsonrpc: "2.0", method: "thread/realtime/sdp", params: { threadId: "t1", sdp: "answer" } });
    session = await starting;
    const disposing = p.live.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    await disposing;
    expect(events.filter((event) => event.type === "failed")).toEqual([{ type: "failed", reason: "exit" }]);
    expect(p.requestsOf("thread/realtime/stop")).toHaveLength(1);
    expect(p.logs.filter((line) => line.startsWith("live codex: stopped"))).toHaveLength(1);
  });
});

describe("codexLiveVoice config checks", () => {
  const mcpConfig = (config: unknown) => ({ FAKE_CODEX_MCP_CONFIG: JSON.stringify(config) });

  it("switches off the shell snapshot and every config MCP server of a bot with a tool selection", async () => {
    const codexHome = join(scratch, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.docs]\ncommand = "docs-server"\n');
    const h = harness({ fake: { CODEX_HOME: codexHome, ...mcpConfig({ docs: { enabled: false } }) } });
    await h.start({ toolScoped: true });
    const args = h.spawned[0]!.args;
    expect(args).toEqual(["app-server", ...codexLiveAppServerArgs(h.spawned[0]!.env, { botId: "bot-live", model: null, toolScoped: true })]);
    const pairs = args.flatMap((arg, index) => args[index - 1] === "-c" ? [arg] : []);
    expect(pairs).toContain("features.shell_snapshot=false");
    expect(pairs).toContain("mcp_servers.docs.enabled=false");
    expect(h.calls().map((call) => call.method)).toContain("config/read");
  });

  it("leaves the shell snapshot and the MCP servers alone for a bot without a tool selection", async () => {
    const h = harness();
    await h.start();
    const pairs = h.spawned[0]!.args.flatMap((arg, index) => h.spawned[0]!.args[index - 1] === "-c" ? [arg] : []);
    expect(pairs).not.toContain("features.shell_snapshot=false");
    expect(pairs.some((arg) => arg.startsWith("mcp_servers"))).toBe(false);
    expect(h.calls().map((call) => call.method)).not.toContain("config/read");
  });

  it("refuses a call whose Codex keeps an MCP server on, before it starts a thread", async () => {
    const h = harness({ fake: mcpConfig({ docs: { command: "docs-server" } }) });
    expect(await refusalOf(h.live.start(h.input({ toolScoped: true })))).toBe("failed");
    expect(h.calls().map((call) => call.method)).not.toContain("thread/start");
    expect(isGone(h.spawned[0]!.child)).toBe(true);
  });

  it("refuses a call whose Codex does not report its MCP servers", async () => {
    const h = harness({ fake: mcpConfig(null) });
    expect(await refusalOf(h.live.start(h.input({ toolScoped: true })))).toBe("failed");
    expect(h.calls().map((call) => call.method)).not.toContain("thread/start");
  });

  it("sends the config read with the account read in the own sign-in mode when the bot has a tool selection", async () => {
    const methods: string[] = [];
    const write = (child: LiveCodexChild) => {
      const original = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
        try { methods.push(JSON.parse(String(chunk)).method); } catch { /* not a request */ }
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof child.stdin.write;
      return child;
    };
    const h = harness({ fake: { FAKE_CODEX_ACCOUNT_MODE: "hang" }, deps: {
      spawn: (args, options) => write(spawn(process.execPath, [FAKE, ...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })),
    } });
    const abort = new AbortController();
    const refused = refusalOf(h.live.start(h.input({ toolScoped: true, approvalMode: "ask", signal: abort.signal })));
    await until(() => methods.includes("account/read") && methods.includes("config/read"));
    abort.abort();
    expect(await refused).toBe("failed");
  });

  it("starts with the shell off, as a guest-driven chat turn does", async () => {
    const h = harness();
    await h.start({ guestConfined: true });
    const env = h.spawned[0]!.env;
    expect(h.spawned[0]!.args).toEqual(["app-server", ...codexOwnLoginArgs(env, null, codexTurnConfigArgs({ botId: "bot-live", guestConfined: true }, env))]);
    expect(h.spawned[0]!.args).toContain("features.shell_tool=false");
  });

  it("refuses a guest-driven call whose Codex did not turn the shell off", async () => {
    const h = harness({ fake: { FAKE_CODEX_IGNORE_FEATURES: "1" } });
    expect(await refusalOf(h.live.start(h.input({ guestConfined: true })))).toBe("failed");
    expect(h.calls().map((call) => call.method)).not.toContain("thread/start");
    expect(isGone(h.spawned[0]!.child)).toBe(true);
  });
});

describe("codexLiveVoice events", () => {
  it("maps transcripts and keeps the agent answer until the turn completes, once", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "turn-answer", FAKE_CODEX_REALTIME_REPLY: "The build passed." } });
    await h.start();
    await until(() => h.events.some((event) => event.type === "answer"));
    expect(h.events).toEqual([
      { type: "started" },
      { type: "transcript", role: "user", delta: "spoken question" },
      { type: "transcript", role: "assistant", delta: "spoken reply" },
      { type: "working" },
      { type: "answer", text: "The build passed." },
    ]);
  });

  it("reports a realtime error as failed error", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "error" } });
    await h.start();
    await until(() => h.events.some((event) => event.type === "failed"));
    expect(h.events).toContainEqual({ type: "failed", reason: "error" });
  });

  it("reports each step of a Codex turn as working", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "working" } });
    await h.start();
    await until(() => h.events.filter((event) => event.type === "working").length >= 3);
    expect(h.events.filter((event) => event.type === "working")).toHaveLength(3);
  });

  it("ignores the steps of another thread", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "working-other-thread" } });
    await h.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.events.some((event) => event.type === "working")).toBe(false);
  });

  it("reports an exit that stop did not cause as failed exit", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "exit" } });
    const session = await h.start();
    await until(() => h.events.some((event) => event.type === "failed"));
    expect(h.events.filter((event) => event.type === "failed")).toEqual([{ type: "failed", reason: "exit" }]);
    const started = Date.now();
    await session.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("sends appendText as a developer item and appendSpeech as speech", async () => {
    const h = harness();
    const session = await h.start();
    session.appendText("The user opened a file.");
    session.appendSpeech("One moment.");
    await until(() => h.calls().some((call) => call.method === "thread/realtime/appendSpeech"));
    const calls = h.calls();
    expect(calls.find((call) => call.method === "thread/realtime/appendText")!.params)
      .toEqual({ threadId: "codex-thread-1", text: "The user opened a file.", role: "developer" });
    expect(calls.find((call) => call.method === "thread/realtime/appendSpeech")!.params)
      .toEqual({ threadId: "codex-thread-1", text: "One moment." });
  });
});

describe("codexLiveVoice thread start checks", () => {
  const profile = {
    thread: { permissions: "profile", approvalPolicy: "on-request" },
    turn: { sandboxPolicy: { type: "workspaceWrite" } },
    fallback: workspaceParams("ask"),
  };

  it("refuses with failed and ends the process when the sandbox differs", async () => {
    const h = harness({ fake: { FAKE_CODEX_RESOLVED_SANDBOX: JSON.stringify({ type: "dangerFullAccess" }) } });
    expect(await refusalOf(h.live.start(h.input()))).toBe("failed");
    await until(() => h.spawned[0]!.child.exitCode !== null || h.spawned[0]!.child.signalCode !== null);
    expect(h.calls().map((call) => call.method)).not.toContain("thread/realtime/start");
  });

  it("refuses with failed when the sandbox is missing", async () => {
    const h = harness({ fake: { FAKE_CODEX_RESOLVED_SANDBOX: "{}" } });
    expect(await refusalOf(h.live.start(h.input()))).toBe("failed");
  });

  it("falls back to the fallback settings when the profile is unsupported", async () => {
    const h = harness({ fake: { FAKE_CODEX_MODE: "config-profile-unsupported" }, deps: { approvalParams: () => profile } });
    await h.start();
    const starts = h.calls().filter((call) => call.method === "thread/start");
    expect(starts).toHaveLength(2);
    expect(starts[0]!.params.permissions).toBe("profile");
    expect(starts[1]!.params).toEqual({ cwd: scratch, ...profile.fallback.thread, ephemeral: false });
  });

  it("does not fall back on any other error", async () => {
    const h = harness({
      fake: { FAKE_CODEX_START_ERROR: JSON.stringify({ code: -32603, message: "disk full" }) },
      deps: { approvalParams: () => profile },
    });
    expect(await refusalOf(h.live.start(h.input()))).toBe("failed");
    expect(h.calls().filter((call) => call.method === "thread/start")).toHaveLength(1);
  });
});

describe("codexLiveVoice approvals by voice", () => {
  const asked = (h: Harness) => h.calls().find((call) => call.method === "thread/realtime/appendSpeech")?.params;
  const spokenNotice = async (h: Harness) => {
    await until(() => asked(h) !== undefined);
    return asked(h);
  };

  it("accepts on a spoken yes and asks with appendSpeech", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_REPLY: "yes" } });
    await h.start();
    await until(() => h.events.some((event) => event.type === "approval"));
    expect(h.events).toContainEqual({ type: "approval", outcome: "accept" });
    expect(asked(h)).toEqual({ threadId: "codex-thread-1", text: "I need your OK to run this command: rm -rf scratch. Should I go ahead? Say yes or no." });
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "accept" });
  });

  it("declines on a spoken no", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_REPLY: "no" } });
    await h.start();
    await until(() => h.events.some((event) => event.type === "approval"));
    expect(h.events).toContainEqual({ type: "approval", outcome: "decline" });
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "decline" });
  });

  it("declines a request for another thread without asking", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_APPROVAL: JSON.stringify({ params: { threadId: "other-thread" } }) } });
    await h.start();
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "decline" });
    expect(asked(h)).toBeUndefined();
  });

  it("declines a multi-part command at once and tells the user", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_COMMAND: "echo one; echo two" } });
    await h.start();
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "decline" });
    expect((await spokenNotice(h)).text).toBe("I need to run a command that I cannot read out in full, so I did not run it. Ask me in the chat to run it.");
  });

  it("declines a network request at once and never asks", async () => {
    const network = { command: null, networkApprovalContext: { host: "example.com", protocol: "https" } };
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_APPROVAL: JSON.stringify({ params: network }) } });
    await h.start();
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "decline" });
    expect((await spokenNotice(h)).text).toBe("I need more access than I have now, so I did not do it. Ask me in the chat to allow it.");
  });

  const fileChange = (thread?: string, change: unknown = { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "" }) => ({
    FAKE_CODEX_REALTIME_MODE: "approval",
    FAKE_CODEX_REALTIME_APPROVAL: JSON.stringify({ method: "item/fileChange/requestApproval" }),
    FAKE_CODEX_REALTIME_ITEM: JSON.stringify({
      ...(thread ? { threadId: thread } : {}),
      item: { id: "realtime-item-1", type: "fileChange", status: "inProgress", changes: [change] },
    }),
  });

  it("asks about a file change with the names of its started item and accepts a yes", async () => {
    const h = harness({ fake: fileChange() });
    await h.start();
    await until(() => h.decision() !== null);
    expect(asked(h).text).toBe("I need your OK to change this file: src/app.ts. Should I go ahead? Say yes or no.");
    expect(h.decision()).toEqual({ decision: "accept" });
  });

  it("declines at once a file change outside the working folder", async () => {
    const h = harness({ fake: fileChange(undefined, { path: "/etc/hosts", kind: { type: "delete" }, diff: "" }) });
    await h.start();
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "decline" });
    expect((await spokenNotice(h)).text).toBe("I need to change files that I cannot read out in full, so I did not change them. Ask me in the chat to change them.");
  });

  it("declines a file change whose item started on another thread", async () => {
    const h = harness({ fake: fileChange("other-thread") });
    await h.start();
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "decline" });
    expect((await spokenNotice(h)).text).toBe("I need to change files that I cannot read out in full, so I did not change them. Ask me in the chat to change them.");
  });

  it("does not take an answer that began before the question", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_STALE: "1" }, timeouts: { approvalMs: 600 } });
    await h.start();
    await until(() => h.events.some((event) => event.type === "approval"));
    expect(h.events).toContainEqual({ type: "approval", outcome: "timeout" });
  });

  it("declines on timeout when nobody answers", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_REPLY: "" }, timeouts: { approvalMs: 150 } });
    await h.start();
    await until(() => h.events.some((event) => event.type === "approval"));
    expect(h.events).toContainEqual({ type: "approval", outcome: "timeout" });
    await until(() => h.decision() !== null);
    expect(h.decision()).toEqual({ decision: "decline" });
  });
});

describe("codexLiveVoice stop and dispose", () => {
  it("sends the stop request, ends the process, and is safe to repeat", async () => {
    const h = harness();
    const session = await h.start();
    await until(() => h.events.some((event) => event.type === "started"));
    const started = Date.now();
    const first = session.stop();
    const second = session.stop();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.calls().map((call) => call.method)).toContain("thread/realtime/stop");
    expect(h.calls().find((call) => call.method === "thread/realtime/stop")!.params).toEqual({ threadId: "codex-thread-1" });
    expect(isGone(h.spawned[0]!.child)).toBe(true);
    await session.stop();
    expect(h.events.filter((event) => event.type === "failed")).toEqual([]);
  });

  it("emits nothing after stop starts", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "exit" } });
    const session = await h.start();
    const stopping = session.stop();
    const before = h.events.length;
    await stopping;
    expect(h.events).toHaveLength(before);
    expect(h.events.some((event) => event.type === "failed")).toBe(false);
  });

  it("ends the call of an open session on dispose, once, before it stops", async () => {
    const h = harness();
    await h.start();
    await until(() => h.events.some((event) => event.type === "started"));
    await h.live.dispose();
    expect(h.events.filter((event) => event.type === "failed")).toEqual([{ type: "failed", reason: "exit" }]);
    await h.live.dispose();
    expect(h.events.filter((event) => event.type === "failed")).toHaveLength(1);
  });

  it("closes the socket of a call and frees it when the provider is disposed during the call", async () => {
    const h = harness();
    const wiring = liveSessionWiring({
      bot: () => ({ name: "Ada" }), history: () => [], cloudHome: false, othersOnLoopback: () => false, saveAgent: () => {},
      codexLive: () => ({ startLiveVoice: (input) => h.live.start(input), cwd: scratch, approvalMode: "ask", botId: "bot-live", model: null }),
    });
    const { sessionId } = await wiring.calls.createSession({ key: "", endpoint: codexLiveEndpoint(), sdp: "offer-sdp", botId: "bot-live", threadId: "t1", voice: "codex" });
    const socket = wiring.calls.openSocket(sessionId, "", codexLiveEndpoint());
    const closed = vi.fn();
    socket.onclose = closed;
    await until(() => socket.readyState === 1);
    await h.live.dispose();
    expect(closed).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    expect(wiring.calls.openSocket(sessionId, "", codexLiveEndpoint()).readyState).toBe(3);
  });

  it("ignores appends after stop", async () => {
    const h = harness();
    const session = await h.start();
    await session.stop();
    session.appendText("late");
    session.appendSpeech("late");
    expect(h.calls().some((call) => call.params?.text === "late")).toBe(false);
  });

  it("stops every open session on dispose", async () => {
    const h = harness();
    await h.start();
    await h.start();
    expect(h.spawned).toHaveLength(2);
    await h.live.dispose();
    expect(h.spawned.every(({ child }) => isGone(child))).toBe(true);
  });
});

describe("codexLiveVoice logging", () => {
  it("logs counters and outcomes only", async () => {
    const h = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "turn-answer", FAKE_CODEX_REALTIME_REPLY: "SECRET-ANSWER" } });
    const session = await h.start({ voiceInstructions: "SECRET-PERSONA", workInstructions: "SECRET-WORK", sdp: "SECRET-OFFER" });
    session.appendText("SECRET-APPEND");
    await until(() => h.events.some((event) => event.type === "answer"));
    await session.stop();

    const approvals = harness({ fake: { FAKE_CODEX_REALTIME_MODE: "approval", FAKE_CODEX_REALTIME_COMMAND: "SECRET-COMMAND" } });
    const approved = await approvals.start();
    await until(() => approvals.events.some((event) => event.type === "approval"));
    await approved.stop();

    const lines = [...h.logs, ...approvals.logs];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^live codex: (started|stopped|refused [a-z-]+)( [A-Za-z]+=\d+)*$/);
    const text = lines.join("\n");
    for (const secret of ["SECRET-", "spoken question", "spoken reply", "fake-codex-answer"]) expect(text).not.toContain(secret);
  });
});

describe("CodexDriver startLiveVoice", () => {
  let instance: ProviderInstance | undefined;

  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
  });

  const create = async (environment: Record<string, string>, config: Record<string, unknown> = {}) => {
    instance = await CodexDriver.create({
      instanceId: "codex-live-test",
      displayName: "Codex Live Test",
      environment: { HOME: scratch, USERPROFILE: scratch, CODEX_HOME: join(scratch, ".codex"), FAKE_CODEX_VERSION: MODERN, ...environment },
      enabled: true,
      config: { cli: FAKE, fullAuto: false, ...config },
    });
    return instance;
  };
  const offer = (): EngineLiveVoiceStart => ({
    sdp: "offer-sdp", cwd: scratch, botId: "bot-live", model: null, approvalMode: "ask", voiceInstructions: "Be brief.", workInstructions: "", history: [], onEvent: () => {},
  });

  it("starts the app-server with no plan arguments and none of the plan or API credentials", async () => {
    const dump = join(scratch, "driver-dump.json");
    const provider = await create({
      FAKE_CODEX_DUMP: dump,
      OPENMAUSBOT_CHATGPT_TOKEN: "leak-plan-token",
      OPENMAUSBOT_CODEX_API_KEY: "leak-api-key",
      OPENAI_API_KEY: "leak-openai-key",
    });
    const session = await provider.startLiveVoice!(offer());
    expect(session.sdp).toBe(FAKE_SDP_ANSWER);
    await session.stop();
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[0]).toBe("app-server");
    expect(seen.argv).toEqual(expect.arrayContaining(["features.plugins=false", "features.computer_use=false", "features.browser_use=false"]));
    for (const name of ["OPENMAUSBOT_CHATGPT_TOKEN", "OPENMAUSBOT_CODEX_API_KEY", "OPENAI_API_KEY"]) expect(seen.env[name]).toBeUndefined();
    expect(JSON.stringify(seen.env)).not.toContain("leak-");
    const start = seen.calls.find((call: { method: string }) => call.method === "thread/start");
    expect(start.params).toMatchObject({ cwd: scratch, approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: false });
  });

  it("starts the app-server with the arguments of a chat turn of the same bot and model", async () => {
    const model = encodeCodexSelection("magpie", "local-model");
    const argvOf = async (file: string, run: (provider: ProviderInstance) => Promise<void>) => {
      const provider = await create({ FAKE_CODEX_DUMP: file });
      try { await run(provider); } finally { await provider.dispose(); instance = undefined; }
      return (JSON.parse(readFileSync(file, "utf8")) as { argv: string[] }).argv;
    };
    const chat = await argvOf(join(scratch, "chat-argv.json"), async (provider) => {
      const done = new Promise<void>((resolve) => { provider.adapter.onEvent((event) => { if (event.type === "turn.completed") resolve(); }); });
      await provider.adapter.sendTurn({ threadId: "same-args", botId: "bot-live", model, text: "hi" });
      await done;
    });
    const call = await argvOf(join(scratch, "call-argv.json"), async (provider) => {
      const session = await provider.startLiveVoice!({ ...offer(), model });
      await session.stop();
    });
    expect(call).toEqual(chat);
    expect(call).toContain("features.plugins=false");
  });

  it("refuses an old Codex and an unsigned account", async () => {
    const old = await create({ FAKE_CODEX_VERSION: "codex-cli 0.169.0" });
    expect(await refusalOf(old.startLiveVoice!(offer()))).toBe("too-old");
    await old.dispose();
    instance = undefined;
    const apiKey = await create({ FAKE_CODEX_ACCOUNT: "apikey" });
    expect(await refusalOf(apiKey.startLiveVoice!(offer()))).toBe("not-signed-in");
  });

  it("refuses the ChatGPT plan token, an endpoint and a managed key", async () => {
    const endpoint = await create({ CODEX_HOME: join(scratch, "endpoint"), OPENMAUSBOT_CODEX_API_KEY: "synthetic-endpoint-key" },
      { endpoint: { url: "http://127.0.0.1:1/v1", models: ["gateway-model"] } });
    expect(await refusalOf(endpoint.startLiveVoice!(offer()))).toBe("unsupported-sign-in");
    await endpoint.dispose();

    const managed = await create({ OPENMAUSBOT_COMPANY_API_KEY: "synthetic-company-fixture" },
      { managed: { url: "http://127.0.0.1:1/v1", models: ["company-codex-model"] } });
    expect(await refusalOf(managed.startLiveVoice!(offer()))).toBe("unsupported-sign-in");
    await managed.dispose();

    const plan = await create({}, { authMode: "chatgpt-plan" });
    expect(await refusalOf(plan.startLiveVoice!(offer()))).toBe("unsupported-sign-in");
  });

  it("stops its sessions when the provider is disposed", async () => {
    const dump = join(scratch, "dispose-dump.json");
    const provider = await create({ FAKE_CODEX_DUMP: dump });
    await provider.startLiveVoice!(offer());
    const pid = JSON.parse(readFileSync(dump, "utf8")).pid as number;
    await provider.dispose();
    instance = undefined;
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });
});
