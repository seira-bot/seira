import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBotLink } from "../bot-link/link.ts";
import { linkedId, peerKey, type Frame, type HandoffFrame, type ResultFrame } from "../bot-link/protocol.ts";
import { createCoordinator, type CoordinateBotsCall, type Coordinator, type CoordinatorHost } from "../coordinator.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { A2aEgressError, type EgressReason, type EgressResult } from "./egress.ts";
import {
  AGENT_ID, DESCRIPTION_MAX, POLL_FIRST_MS, PROBLEM, RESULT_TEXT, RUNNING_MAX, SENDS_MAX, TASK_MAX_MS, cardAddress, createA2aOutbound,
  teammateDescription, type A2aOutbound, type A2aRequestFn,
} from "./outbound.ts";
import { ERR, NOTE_MAX, farCard } from "./protocol.ts";
import { createTaskIndex, type TaskIndex } from "./tasks.ts";
import { createA2aTransport } from "./transport.ts";

type Json = Record<string, any>;
type FarCall = { url: string; method: "GET" | "POST"; headers: Record<string, string>; body: Json | undefined; signal: AbortSignal | undefined; at: number };
type Answer = (call: FarCall) => EgressResult | Promise<EgressResult>;

const KEY = "abcd1234";
const PLACE = { id: "a2a:0000000000000001", name: "Trip planner" };
const ADDRESS = "https://far.example/agents/trip";
const CARD_URL = "https://far.example/agents/trip/.well-known/agent-card.json";
const RPC = "https://far.example/agents/trip/rpc";
const CARD = {
  name: "Far name", description: "Plans trips.", supportedInterfaces: [{ url: RPC, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  skills: [{ id: "plan", name: "Plan trips" }, { id: "book", name: "Book hotels" }],
};
const STOPPED = { t: "result", ok: false, text: RESULT_TEXT.stopped, outcome: "stopped" };
const UNSEEN_TEXT = "a‮b​c\u{e0041}dㅤe\u0007f \u{1f469}‍\u{1f4bb}\nline two\tend";
const SEEN_TEXT = "a bcde f \u{1f469}\u{1f4bb}\nline two\tend";

const json = (value: unknown, status = 200): EgressResult => ({ status, body: JSON.stringify(value), sent: true });
const raw = (body: string, status = 200): Answer => () => ({ status, body, sent: true });
const result = (value: unknown): Answer => (call) => json({ jsonrpc: "2.0", id: call.body?.id, result: value });
const rpcError = (code: number, message: string): Answer => (call) => json({ jsonrpc: "2.0", id: call.body?.id, error: { code, message } });
const fails = (reason: EgressReason, sent: boolean): Answer => () => { throw new A2aEgressError(reason, "fake", sent); };
const hangs: Answer = (call) => new Promise<EgressResult>((_resolve, reject) => {
  call.signal?.addEventListener("abort", () => { reject(new A2aEgressError("aborted", "fake", true)); }, { once: true });
});
const message = (text: string) => ({ messageId: "far-message", role: "ROLE_AGENT", parts: [{ text }] });
const task = (state: string, more: Json = {}) => ({ id: "far-1", contextId: "ctx-1", status: { state: `TASK_STATE_${state}` }, ...more });
const sent = (state: string, more: Json = {}) => result({ task: task(state, more) });
const handoff = (id: string, more: Partial<HandoffFrame> = {}): HandoffFrame => ({
  t: "handoff", id, to: AGENT_ID, from: { botId: "writer", name: "Writer Bot", threadId: "w-thread" }, thread: "thread-1", text: `Plan ${id}`,
  mode: "work", origin: { kind: "person", quote: "Ask the planner" }, person: "Dana", ...more,
});

/** A far agent: the card answers every GET, and each JSON-RPC method takes its queued answers, then its default. */
function fakeFar() {
  const calls: FarCall[] = [];
  const queues = new Map<string, Answer[]>();
  const defaults = new Map<string, Answer>([["GetTask", result(task("WORKING"))], ["CancelTask", result(task("CANCELED"))]]);
  const card: { answer: Answer } = { answer: () => json(CARD) };
  const request: A2aRequestFn = async (url, options) => {
    const call: FarCall = {
      url: url.href, method: options.method, headers: options.headers ?? {}, signal: options.signal, at: Date.now(),
      body: options.body === undefined ? undefined : JSON.parse(options.body) as Json,
    };
    calls.push(call);
    if (options.method === "GET") return card.answer(call);
    const method = String(call.body?.method);
    const answer = queues.get(method)?.shift() ?? defaults.get(method);
    if (!answer) throw new Error(`no answer for ${method}`);
    return answer(call);
  };
  return {
    calls, card, request,
    on(method: string, ...answers: Answer[]) { queues.set(method, [...(queues.get(method) ?? []), ...answers]); },
    rpc: (method: string) => calls.filter((call) => call.body?.method === method),
  };
}
type Far = ReturnType<typeof fakeFar>;

const dirs: string[] = [];
const opened: Array<{ close(): void }> = [];

function fixture(options: { url?: string | null; token?: string | null; far?: Far; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "a2a-outbound-"));
  if (!options.dir) dirs.push(dir);
  const frames: Frame[] = [];
  const link = { receive: (peer: string, list: readonly unknown[]) => { if (peer === KEY) frames.push(...(list as Frame[])); } };
  const far = options.far ?? fakeFar();
  const settings = { url: options.url === undefined ? ADDRESS : options.url, token: options.token === undefined ? "far-token" : options.token };
  const tasks: TaskIndex = createTaskIndex(dir, () => Date.now());
  const logs: string[] = [];
  const outbound: A2aOutbound = createA2aOutbound({
    link, key: KEY, place: PLACE, tasks, request: far.request, log: (line) => { logs.push(line); },
    url: () => (settings.url ? new URL(settings.url) : null), token: () => settings.token,
  });
  opened.push(outbound);
  const results = () => frames.filter((frame): frame is ResultFrame => frame.t === "result");
  const resultOf = (id: string) => results().find((frame) => frame.id === id);
  const hellos = () => frames.flatMap((frame) => (frame.t === "hello" ? [frame] : []));
  return { dir, frames, results, resultOf, hellos, far, settings, tasks, outbound, logs };
}

const flush = async () => { for (let turn = 0; turn < 100; turn += 1) await Promise.resolve(); };
const step = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

describe("the A2A outbound side", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    for (const one of opened.splice(0)) one.close();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  describe("the far card", () => {
    it("reads the card with the token and names the admin's teammate, with the card's words cleaned (AC-38)", async () => {
      const { outbound, far, hellos } = fixture();
      far.card.answer = () => json({ ...CARD, description: "Plans\u0007 trips.‮ Fast\n\nand cheap", skills: [{ id: "plan", name: "Plan\ttrips" }, { id: "book", name: "Book hotels" }] });
      await outbound.connect();
      expect(far.calls).toEqual([expect.objectContaining({ url: CARD_URL, method: "GET", headers: { accept: "application/json", authorization: "Bearer far-token" } })]);
      expect(hellos()).toEqual([{ t: "hello", place: PLACE, bots: [{ id: AGENT_ID, name: PLACE.name, description: "Plans trips. Fast and cheap Skills: Plan trips, Book hotels." }] }]);
      expect([outbound.endpoint(), outbound.problem()]).toEqual([RPC, null]);
    });

    it("cuts the description to its limit and leaves it out when the card has no words", () => {
      const long = teammateDescription(farCard.parse({ ...CARD, description: `${"x".repeat(DESCRIPTION_MAX - 1)}\u{1F600}more`, skills: [] }));
      expect(long).toBe("x".repeat(DESCRIPTION_MAX - 1));
      expect(teammateDescription(farCard.parse({ ...CARD, description: "\u0000 ​", skills: [] }))).toBeUndefined();
    });

    it.each([
      ["another host", "https://other.example/rpc"],
      ["another scheme", "http://far.example/agents/trip/rpc"],
      ["another port", "https://far.example:8443/rpc"],
      ["a user name in it", "https://user:pw@far.example/rpc"],
    ])("never dials a JSON-RPC address with %s, and a hand-off fails with no request (AC-32)", async (_name, url) => {
      const { outbound, far, hellos, resultOf, tasks } = fixture();
      far.card.answer = () => json({ ...CARD, supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] });
      await outbound.connect();
      expect([outbound.problem(), outbound.endpoint(), hellos()]).toEqual([PROBLEM.otherSite, null, []]);
      outbound.send(handoff("h1"));
      await flush();
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: false, text: `${PROBLEM.otherSite} The work was not sent.` });
      expect(far.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
      expect(tasks.get("h1")).toBeNull();
    });

    it.each([
      ["a 401", raw("", 401), PROBLEM.token],
      ["a 404", raw("", 404), PROBLEM.card],
      ["a body that is not JSON", raw("<html>"), PROBLEM.card],
      ["a body that is not a card", () => json({ name: "x" }), PROBLEM.card],
      ["only an A2A 0.3 interface", () => json({ ...CARD, supportedInterfaces: [{ url: RPC, protocolBinding: "JSONRPC", protocolVersion: "0.3" }] }), PROBLEM.noRpc],
      ["only a gRPC interface", () => json({ ...CARD, supportedInterfaces: [{ url: RPC, protocolBinding: "GRPC", protocolVersion: "1.0" }] }), PROBLEM.noRpc],
      ["an address that is not a URL", () => json({ ...CARD, supportedInterfaces: [{ url: "not a url", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }), PROBLEM.noRpc],
      ["a private address", fails("refused", false), PROBLEM.address],
      ["a redirect", fails("redirect", true), PROBLEM.redirect],
      ["a card too large", fails("too-large", true), PROBLEM.tooLarge],
      ["no connection", fails("network", false), PROBLEM.unreachable],
      ["a timeout", fails("timeout", true), PROBLEM.unreachable],
    ])("names the problem for %s, and tells the link of no teammate", async (_name, answer, problem) => {
      const { outbound, far, hellos } = fixture();
      far.card.answer = answer;
      await outbound.connect();
      expect([outbound.problem(), outbound.endpoint(), hellos()]).toEqual([problem, null, []]);
      far.card.answer = () => json(CARD);
      await outbound.connect();
      expect([outbound.problem(), outbound.endpoint(), hellos().length]).toEqual([null, RPC, 1]);
    });

    it("takes the card address from the admin's address", () => {
      expect([
        "https://far.example/agents/trip/", "https://far.example", "https://far.example/card.json?v=2#top", "https://far.example/a?b=1#c",
      ].map((url) => cardAddress(new URL(url)).href)).toEqual([
        CARD_URL, "https://far.example/.well-known/agent-card.json", "https://far.example/card.json?v=2", "https://far.example/a/.well-known/agent-card.json",
      ]);
    });

    it("with no address, tells the link of no teammate and sends nothing", async () => {
      const { outbound, far, hellos } = fixture({ url: null });
      await outbound.connect();
      expect([hellos(), far.calls, outbound.problem()]).toEqual([[{ t: "hello", place: PLACE, bots: [] }], [], null]);
    });

    it("shares one card read between calls that overlap", async () => {
      const { outbound, far } = fixture();
      await Promise.all([outbound.connect(), outbound.connect()]);
      expect(far.calls).toHaveLength(1);
    });
  });

  describe("a hand-off", () => {
    it("goes out as one SendMessage with the hand-off id and the text only, with the bearer and the A2A version (AC-33)", async () => {
      const { outbound, far, resultOf } = fixture();
      far.on("SendMessage", sent("COMPLETED", { artifacts: [{ parts: [{ text: "Done" }] }] }));
      outbound.send(handoff("h1"));
      await flush();
      const [post] = far.rpc("SendMessage");
      expect(post).toMatchObject({
        url: RPC, method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "a2a-version": "1.0", authorization: "Bearer far-token" },
        body: {
          jsonrpc: "2.0", id: 1, method: "SendMessage",
          params: { message: { messageId: "h1", role: "ROLE_USER", parts: [{ text: "Plan h1" }] }, configuration: { acceptedOutputModes: ["text/plain"], returnImmediately: true } },
        },
      });
      expect(Object.keys(post!.body!.params.message).sort()).toEqual(["messageId", "parts", "role"]);
      const wire = JSON.stringify(post!.body);
      for (const hidden of ["Dana", "Writer Bot", "w-thread", "thread-1", "Ask the planner"]) expect(wire).not.toContain(hidden);
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: true, text: "Done" });
    });

    it("sends no bearer when the far agent takes no token", async () => {
      const { outbound, far } = fixture({ token: null });
      far.on("SendMessage", sent("COMPLETED"));
      outbound.send(handoff("h1"));
      await flush();
      expect(far.calls.map((call) => "authorization" in call.headers)).toEqual([false, false]);
    });

    it("is sent once when the link gives it again while it runs", async () => {
      const { outbound, far } = fixture();
      far.on("SendMessage", hangs);
      outbound.send(handoff("h1"));
      await flush();
      outbound.send(handoff("h1"));
      await flush();
      expect(far.rpc("SendMessage")).toHaveLength(1);
    });

    it.each([
      ["COMPLETED from its artifacts, with the parts that are not text counted", task("COMPLETED", { artifacts: [{ parts: [{ text: "Line 1" }, { text: "Line\u00072" }, { raw: "AAAA", mediaType: "image/png" }] }] }),
        { ok: true, text: "Line 1\nLine 2\n\n(1 part that is not text was left out.)" }],
      ["COMPLETED from its status message when it has no artifacts", task("COMPLETED", { status: { state: "TASK_STATE_COMPLETED", message: message("Short answer") } }),
        { ok: true, text: "Short answer" }],
      ["COMPLETED with no text", task("COMPLETED"), { ok: true, text: RESULT_TEXT.empty }],
      ["INPUT_REQUIRED with the question", task("INPUT_REQUIRED", { status: { state: "TASK_STATE_INPUT_REQUIRED", message: message("Which city?") } }),
        { ok: true, text: `${RESULT_TEXT.asks}\n\nWhich city?` }],
      ["AUTH_REQUIRED", task("AUTH_REQUIRED"), { ok: false, text: RESULT_TEXT.signIn }],
      ["FAILED with the far note", task("FAILED", { status: { state: "TASK_STATE_FAILED", message: message(`Out of\u0000credit ${"x".repeat(NOTE_MAX)}`) } }),
        { ok: false, text: `Out of credit ${"x".repeat(NOTE_MAX - 14)}` }],
      ["FAILED with no note", task("FAILED"), { ok: false, text: RESULT_TEXT.failed }],
      ["REJECTED", task("REJECTED"), { ok: false, text: RESULT_TEXT.refused, outcome: "refused" }],
      ["CANCELED", task("CANCELED"), { ok: false, text: RESULT_TEXT.stoppedThere, outcome: "stopped" }],
    ])("ends as the far task ends: %s (AC-34)", async (_name, far1, end) => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", result({ task: far1 }));
      outbound.send(handoff("h1"));
      await flush();
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ...end });
      expect(tasks.get("h1")).toMatchObject({ dir: "out", bot: AGENT_ID, thread: "thread-1", context: "ctx-1", farTask: "far-1", state: far1.status.state });
    });

    it("keeps the far context of each thread and answers an input request in the same far task (AC-34)", async () => {
      const { outbound, far, results, tasks } = fixture();
      far.on("SendMessage",
        sent("INPUT_REQUIRED", { status: { state: "TASK_STATE_INPUT_REQUIRED", message: message("Which city?") } }),
        sent("COMPLETED"), sent("COMPLETED"), result({ task: { ...task("COMPLETED"), id: "far-2", contextId: "ctx-2" } }));
      outbound.send(handoff("h1"));
      await flush();
      expect(tasks.outOf("thread-1")).toEqual({ far: "ctx-1", inputTask: "far-1" });
      outbound.send(handoff("h2"));
      await flush();
      expect(tasks.outOf("thread-1")).toEqual({ far: "ctx-1" });
      outbound.send(handoff("h3"));
      await flush();
      outbound.send(handoff("h4", { thread: "thread-2" }));
      await flush();
      const sentMessages = far.rpc("SendMessage").map((call) => call.body!.params.message as Json);
      expect(sentMessages.map((one) => [one.messageId, one.contextId, one.taskId])).toEqual([
        ["h1", undefined, undefined], ["h2", "ctx-1", "far-1"], ["h3", "ctx-1", undefined], ["h4", undefined, undefined],
      ]);
      expect(tasks.outOf("thread-2")).toEqual({ far: "ctx-2" });
      expect(results().map((frame) => frame.ok)).toEqual([true, true, true, true]);
    });

    it("takes a message answer as the result and keeps its context (AC-34)", async () => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", result({ message: { ...message("Hi\u0007there"), contextId: "ctx-9" } }), sent("COMPLETED"));
      outbound.send(handoff("h1"));
      await flush();
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: true, text: "Hi there" });
      expect(tasks.get("h1")).toMatchObject({ state: "TASK_STATE_COMPLETED" });
      outbound.send(handoff("h2"));
      await flush();
      expect(far.rpc("SendMessage")[1]!.body!.params.message.contextId).toBe("ctx-9");
    });

    it("drops unseen characters from the far words in a result, a note, a refusal and the card, emoji joiners too", async () => {
      const { outbound, far, resultOf, hellos } = fixture();
      far.card.answer = () => json({ ...CARD, description: UNSEEN_TEXT, skills: [] });
      far.on("SendMessage",
        sent("COMPLETED", { artifacts: [{ parts: [{ text: UNSEEN_TEXT }] }] }),
        sent("FAILED", { status: { state: "TASK_STATE_FAILED", message: message(UNSEEN_TEXT) } }),
        rpcError(ERR.INVALID_PARAMS, UNSEEN_TEXT));
      await outbound.connect();
      for (const id of ["h1", "h2", "h3"]) { outbound.send(handoff(id)); await flush(); }
      expect(["h1", "h2", "h3"].map((id) => resultOf(id)?.text)).toEqual([SEEN_TEXT, SEEN_TEXT, `${RESULT_TEXT.refused} It said: ${SEEN_TEXT}`]);
      expect(hellos()[0]?.bots[0]?.description).toBe(SEEN_TEXT.replace(/\s+/gu, " "));
    });

    it("ends as refused on a JSON-RPC error, with the far words cleaned and cut (AC-34)", async () => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", rpcError(ERR.INVALID_PARAMS, `No\u0000way${"x".repeat(3_000)}`));
      outbound.send(handoff("h1"));
      await flush();
      const text = resultOf("h1")!.text;
      expect(text.startsWith(`${RESULT_TEXT.refused} It said: No way`)).toBe(true);
      expect(text).toHaveLength(RESULT_TEXT.refused.length + " It said: ".length + NOTE_MAX);
      expect(tasks.get("h1")).toMatchObject({ state: "TASK_STATE_REJECTED" });
    });

    it("ends on a 401 and names the token problem", async () => {
      const { outbound, far, resultOf } = fixture();
      far.on("SendMessage", raw("", 401));
      outbound.send(handoff("h1"));
      await flush();
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: false, text: RESULT_TEXT.token });
      expect(outbound.problem()).toBe(PROBLEM.token);
    });

    it.each([
      ["a body that is not JSON", raw("not json")],
      ["a 500", raw("{}", 500)],
      ["a result with neither task nor message", result({})],
      ["a result with both", result({ task: task("COMPLETED"), message: message("x") })],
    ])("ends as failed on %s, and does not send it again", async (_name, answer) => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", answer);
      outbound.send(handoff("h1"));
      await flush();
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: false, text: RESULT_TEXT.noAnswer });
      expect([far.rpc("SendMessage").length, tasks.get("h1")?.state]).toEqual([1, "TASK_STATE_FAILED"]);
    });
  });

  describe("polling", () => {
    it("polls GetTask after 2, 4, 8 and 16 seconds, then every 30, while the far task works (AC-35)", async () => {
      const { outbound, far, resultOf } = fixture();
      far.on("SendMessage", sent("WORKING"));
      far.on("GetTask", ...Array.from({ length: 5 }, () => result(task("WORKING"))), result(task("COMPLETED", { artifacts: [{ parts: [{ text: "Booked" }] }] })));
      const start = Date.now();
      outbound.send(handoff("h1"));
      await flush();
      await step(90_000);
      const polls = far.rpc("GetTask");
      expect(polls.map((call) => call.at - start)).toEqual([2_000, 6_000, 14_000, 30_000, 60_000, 90_000]);
      expect(polls[0]!.body!.params).toEqual({ id: "far-1", historyLength: 0 });
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: true, text: "Booked" });
      await step(600_000);
      expect(far.rpc("GetTask")).toHaveLength(6);
    });

    it("ends the hand-off as failed after 6 hours and asks the far agent to cancel (AC-35)", async () => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", sent("WORKING"));
      outbound.send(handoff("h1"));
      await flush();
      await step(TASK_MAX_MS - 1);
      expect(resultOf("h1")).toBeUndefined();
      await step(1);
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: false, text: RESULT_TEXT.tooLong });
      expect(far.rpc("CancelTask").map((call) => [call.body!.params, call.headers.authorization])).toEqual([[{ id: "far-1" }, "Bearer far-token"]]);
      expect(tasks.get("h1")).toMatchObject({ state: "TASK_STATE_FAILED", farTask: "far-1" });
      const polls = far.rpc("GetTask").length;
      await step(600_000);
      expect(far.rpc("GetTask")).toHaveLength(polls);
    });

    it("keeps polling through a failed poll, and ends when the far agent no longer knows the task", async () => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", sent("SUBMITTED"));
      far.on("GetTask", fails("network", true), raw("garbled"), result({ ...task("COMPLETED"), id: "far-other" }), rpcError(ERR.TASK_NOT_FOUND, "Task not found"));
      outbound.send(handoff("h1"));
      await flush();
      await step(30_000);
      expect(far.rpc("GetTask")).toHaveLength(4);
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: false, text: RESULT_TEXT.gone });
      expect(tasks.get("h1")).toMatchObject({ state: "TASK_STATE_FAILED" });
    });
  });

  describe("a cancel", () => {
    it("during the send aborts the request, ends the hand-off as stopped and sends no CancelTask (AC-36)", async () => {
      const { outbound, far, results } = fixture();
      far.on("SendMessage", hangs);
      outbound.send(handoff("h1"));
      await flush();
      outbound.cancel("h1");
      await flush();
      expect(far.rpc("SendMessage")[0]!.signal?.aborted).toBe(true);
      expect(results()).toEqual([{ id: "h1", ...STOPPED }]);
      expect(far.rpc("CancelTask")).toEqual([]);
    });

    it("while polling stops the polls, asks the far agent to cancel and marks the task cancelled (AC-36)", async () => {
      const { outbound, far, results, tasks } = fixture();
      far.on("SendMessage", sent("WORKING"));
      outbound.send(handoff("h1"));
      await flush();
      await step(POLL_FIRST_MS);
      outbound.cancel("h1");
      await flush();
      expect(results()).toEqual([{ id: "h1", ...STOPPED }]);
      expect(far.rpc("CancelTask").map((call) => call.body!.params)).toEqual([{ id: "far-1" }]);
      expect(tasks.get("h1")).toMatchObject({ state: "TASK_STATE_CANCELED", farTask: "far-1" });
      await step(600_000);
      expect(far.rpc("GetTask")).toHaveLength(1);
    });

    it("after the result of an input request leaves the far task waiting, and the next hand-off answers in it", async () => {
      const { outbound, far, results, tasks } = fixture();
      far.on("SendMessage", sent("INPUT_REQUIRED", { status: { state: "TASK_STATE_INPUT_REQUIRED", message: message("Which city?") } }), sent("COMPLETED"));
      outbound.send(handoff("h1"));
      await flush();
      outbound.cancel("h1");
      await flush();
      expect(far.rpc("CancelTask")).toEqual([]);
      expect(tasks.get("h1")).toMatchObject({ state: "TASK_STATE_INPUT_REQUIRED", farTask: "far-1" });
      expect(results().map((frame) => frame.id)).toEqual(["h1", "h1"]);
      outbound.send(handoff("h2"));
      await flush();
      expect(far.rpc("SendMessage")[1]!.body!.params.message).toMatchObject({ contextId: "ctx-1", taskId: "far-1" });
    });

    it("for a hand-off it does not run still ends it on the link as stopped, so the link keeps nothing to send again (AC-36)", async () => {
      const { outbound, far, results } = fixture();
      outbound.cancel("gone-1");
      await flush();
      expect([results(), far.calls]).toEqual([[{ id: "gone-1", ...STOPPED }], []]);
    });
  });

  describe("a request that may have left (AC-37)", () => {
    it.each([
      ["a timeout", fails("timeout", true)],
      ["a broken connection", fails("network", true)],
      ["an answer too large", fails("too-large", true)],
    ])("is not sent again after %s, and the hand-off ends as failed", async (_name, answer) => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", answer, sent("COMPLETED"));
      outbound.send(handoff("h1"));
      await flush();
      await step(60_000);
      expect(resultOf("h1")).toEqual({ t: "result", id: "h1", ok: false, text: RESULT_TEXT.noAnswer });
      expect([far.rpc("SendMessage").length, tasks.get("h1")?.state]).toEqual([1, "TASK_STATE_FAILED"]);
    });

    it("is tried again only while no connection opened, at most 3 times", async () => {
      const { outbound, far, resultOf, tasks } = fixture();
      far.on("SendMessage", fails("network", false), fails("timeout", false), sent("COMPLETED"), fails("network", false), fails("network", false), fails("network", false));
      outbound.send(handoff("h1"));
      await flush();
      await step(POLL_FIRST_MS);
      expect(far.rpc("SendMessage")).toHaveLength(2);
      await step(2 * POLL_FIRST_MS);
      expect(far.rpc("SendMessage")).toHaveLength(3);
      expect(resultOf("h1")).toMatchObject({ ok: true });
      outbound.send(handoff("h2"));
      await flush();
      await step(3 * POLL_FIRST_MS);
      expect(far.rpc("SendMessage")).toHaveLength(6);
      expect(resultOf("h2")).toEqual({ t: "result", id: "h2", ok: false, text: RESULT_TEXT.notSent });
      expect(tasks.get("h2")).toBeNull();
    });

    it("after a restart is read back from the far task, never sent again", async () => {
      const far = fakeFar();
      const first = fixture({ far });
      far.on("SendMessage", sent("WORKING"), hangs);
      first.outbound.send(handoff("h1"));
      first.outbound.send(handoff("h2"));
      await flush();
      first.outbound.close();
      far.on("GetTask", result(task("COMPLETED", { artifacts: [{ parts: [{ text: "Booked" }] }] })));
      const second = fixture({ far, dir: first.dir });
      second.outbound.send(handoff("h1"));
      second.outbound.send(handoff("h2"));
      await flush();
      expect(far.rpc("SendMessage").map((call) => call.body!.params.message.messageId)).toEqual(["h1", "h2"]);
      expect(second.resultOf("h1")).toEqual({ t: "result", id: "h1", ok: true, text: "Booked" });
      expect(second.resultOf("h2")).toEqual({ t: "result", id: "h2", ok: false, text: RESULT_TEXT.noAnswer });
      expect([second.tasks.get("h1")?.state, second.tasks.get("h2")?.state]).toEqual(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED"]);
    });

    it("after a restart, a cancel for a far task that still works asks the far agent to cancel", async () => {
      const far = fakeFar();
      const first = fixture({ far });
      far.on("SendMessage", sent("WORKING"));
      first.outbound.send(handoff("h1"));
      await flush();
      first.outbound.close();
      const second = fixture({ far, dir: first.dir });
      second.outbound.cancel("h1");
      await flush();
      expect(second.results()).toEqual([{ id: "h1", ...STOPPED }]);
      expect(far.rpc("CancelTask").map((call) => call.body!.params)).toEqual([{ id: "far-1" }]);
      expect(second.tasks.get("h1")).toMatchObject({ state: "TASK_STATE_CANCELED" });
    });
  });

  describe("limits", () => {
    it(`fails a hand-off at once when ${RUNNING_MAX} are open, and sends nothing for it`, async () => {
      const { outbound, far, results, tasks } = fixture();
      far.on("SendMessage", ...Array.from({ length: RUNNING_MAX }, () => hangs));
      for (let n = 1; n <= RUNNING_MAX + 1; n += 1) outbound.send(handoff(`h${n}`));
      await flush();
      expect(far.rpc("SendMessage")).toHaveLength(RUNNING_MAX);
      expect(results()).toEqual([{ t: "result", id: `h${RUNNING_MAX + 1}`, ok: false, text: RESULT_TEXT.busy }]);
      expect(tasks.get(`h${RUNNING_MAX + 1}`)).toBeNull();
    });

    it(`sends at most ${SENDS_MAX} hand-offs a minute`, async () => {
      const { outbound, far, resultOf } = fixture();
      far.on("SendMessage", ...Array.from({ length: SENDS_MAX + 1 }, () => sent("COMPLETED")));
      for (let n = 1; n <= SENDS_MAX + 1; n += 1) { outbound.send(handoff(`h${n}`)); await flush(); }
      expect(far.rpc("SendMessage")).toHaveLength(SENDS_MAX);
      expect(resultOf(`h${SENDS_MAX + 1}`)).toEqual({ t: "result", id: `h${SENDS_MAX + 1}`, ok: false, text: RESULT_TEXT.busy });
      await step(60_000);
      outbound.send(handoff("later"));
      await flush();
      expect(resultOf("later")).toMatchObject({ ok: true });
    });
  });

  it("close stops every hand-off with no result and no request, and later frames do nothing", async () => {
    const { outbound, far, frames } = fixture();
    far.on("SendMessage", sent("WORKING"), hangs);
    outbound.send(handoff("h1"));
    outbound.send(handoff("h2"));
    await flush();
    const seen = [frames.length, far.calls.length];
    outbound.close();
    await step(600_000);
    outbound.send(handoff("h3"));
    outbound.cancel("h1");
    await outbound.connect();
    await flush();
    expect(far.rpc("SendMessage")[1]!.signal?.aborted).toBe(true);
    expect([frames.length, far.calls.length]).toEqual(seen);
  });
});

describe("the A2A outbound side on a real guest link", () => {
  const WRITER = { id: "writer", name: "Writer" };
  const call = (botIds: string[], text: string): CoordinateBotsCall => ({ botIds, message: text, rework: false, thread: "standing", reply: "resume", consult: false });
  const until = async (what: () => boolean, label: string, ms = 8_000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error(`timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

  async function linked() {
    const dir = mkdtempSync(join(tmpdir(), "a2a-outbound-link-"));
    const key = peerKey(PLACE.id);
    const threads = new Set<string>();
    const rows: Array<{ status: string; result: string }> = [];
    let real!: Coordinator;
    const link = createBotLink({
      dataDir: dir, coordinator: () => real, bots: () => [WRITER], bot: (id) => (id === WRITER.id ? WRITER : undefined), level: () => "full",
      openThread: (bot) => { const id = `${bot.id}-work-${threads.size + 1}`; threads.add(id); return id; },
      hasThread: (_botId, threadId) => threads.has(threadId), personName: () => "Dana", sentRow: () => {},
      resultRow: (_parent, child) => { rows.push({ status: child.status, result: child.result }); },
      kick: () => { queueMicrotask(() => { try { real.tick(); } catch { /* closed */ } }); },
      policy: { key, exposed: () => false, admit: () => null, failText: () => "The work failed on the other side.", words: { handedTo: "Handed to the A2A agent.", otherSide: "the A2A agent" }, record: () => {} },
    });
    const inner: CoordinatorHost = {
      validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, park: () => {},
      names: (node, parent) => ({ requester: parent ? parent.botId : "Sam", assignee: node.botId }),
      levelOf: () => ({ level: "full" }), chiefOf: () => false, run: async () => ({ ok: true, text: "" }),
    };
    real = createCoordinator({ dataDir: dir, host: link.host(inner), log: () => {} });
    const ticker = setInterval(() => real.tick(), 15);
    link.turnOn({ self: { id: "here-environment", name: "Here" }, origin: PLACE.id, token: "a2a", peer: PLACE });
    const far = fakeFar();
    const outbound = createA2aOutbound({ link, key, place: PLACE, url: () => new URL(ADDRESS), token: () => "far-token", tasks: createTaskIndex(dir, Date.now), request: far.request });
    const routed = { sent: [] as string[], cancelled: [] as string[] };
    const transport = createA2aTransport({
      link, key, inbound: { settled: () => {}, close: () => {} },
      outbound: { send: (frame) => { routed.sent.push(frame.id); outbound.send(frame); }, cancel: (id) => { routed.cancelled.push(id); outbound.cancel(id); }, close: () => { outbound.close(); } },
    });
    transport.start();
    closers.push(async () => {
      transport.close();
      clearInterval(ticker);
      link.close();
      try { real.close(); } catch { /* closed */ }
      await removeTempDir(dir);
    });
    let turns = 0;
    const handOff = async (text: string, threadId: string) => {
      const id = `turn-${++turns}`, address = { botId: WRITER.id, threadId };
      real.beginTurn({ id, address, brief: "Plan it", level: "full", origin: { kind: "user", request: "Plan it" } });
      await link.coordinate(call([linkedId(key, AGENT_ID)], text), { sender: WRITER, address, generation: id, external: false, handed: () => {} }, async () => ({ status: 200, body: { receipts: [] } }));
      real.endTurn(id, { ok: true, text: "Handed on." });
    };
    return { key, link, far, outbound, transport, routed, rows, handOff, coordinator: () => real };
  }

  it("lists the admin's name, carries a hand-off out and its result back, keeps a far input request open, and a cancel leaves nothing for a new session (AC-36, AC-38)", async () => {
    const { key, link, far, outbound, transport, routed, rows, handOff, coordinator } = await linked();
    await outbound.connect();
    expect(link.agents()).toEqual([expect.objectContaining({ id: linkedId(key, AGENT_ID), name: PLACE.name })]);

    far.on("SendMessage", sent("INPUT_REQUIRED", { status: { state: "TASK_STATE_INPUT_REQUIRED", message: message("Which city?") } }), hangs);
    await handOff("Plan the trip", "writer-first");
    await until(() => rows.some((row) => row.status === "completed" && row.result.includes("Which city?")), "the result reaches the requester");
    expect(JSON.stringify(far.rpc("SendMessage")[0]!.body)).not.toContain("Dana");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(far.rpc("CancelTask")).toEqual([]);

    await handOff("Plan another trip", "writer-second");
    await until(() => far.rpc("SendMessage").length === 2, "the second hand-off goes out");
    coordinator().cancelDirect("writer-second");
    await until(() => routed.cancelled.includes(routed.sent[1]!), "the cancel reaches the outbound side");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(far.rpc("SendMessage")[1]!.signal?.aborted).toBe(true);
    expect(routed.cancelled).toContain(routed.sent[1]);
    expect(far.rpc("CancelTask")).toEqual([]);

    const before = [routed.sent.length, routed.cancelled.length];
    transport.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([routed.sent.length, routed.cancelled.length, far.rpc("SendMessage").length]).toEqual([...before, 2]);
    expect(routed.sent).toHaveLength(2);
  });
});
