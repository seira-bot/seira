// The outbound side of one A2A peer: it reads the far agent's card, names the one teammate it gives this server, and
// turns each hand-off that the guest link sends to the peer into one SendMessage, then polls the far task until it ends.
//
// Security: the far agent is an outside party. Every request goes through the egress check (public addresses only, no
// redirect, a size limit on every answer). A SendMessage whose body may have left is never sent again: the hand-off is in
// the task index before the request goes out, so a hand-off that the link sends again after a restart is only read back.
// At most RUNNING_MAX hand-offs are open at one time, and each is polled for TASK_MAX_MS at most. Far text reaches a bot
// only as a teammate's result, cut to its limit and without control characters. Open risk: that text can still try to
// steer the bot.
import { z } from "zod";

import type { BotLink } from "../bot-link/link.ts";
import { frameSchema, type HandoffFrame, type LinkedBot } from "../bot-link/protocol.ts";
import { ADMIT, createFrameBudget } from "../host/linked-servers-admit.ts";
import { defuse } from "../records-block.ts";
import { A2aEgressError, a2aRequest, type EgressDeps, type EgressOptions, type EgressResult } from "./egress.ts";
import {
  CARD_BODY_MAX, ERR, NOTE_MAX, RESULT_TEXT_MAX, RPC_BODY_MAX, farCard, farSendResult, farTask, isTerminal, jsonRpcInterface,
  type FarCard, type FarTask, type TaskState,
} from "./protocol.ts";
import type { TaskEntry, TaskIndex } from "./tasks.ts";

/** The id of the one teammate an A2A peer gives this server. */
export const AGENT_ID = "agent";
export const CARD_TIMEOUT_MS = 10_000;
export const RPC_TIMEOUT_MS = 60_000;
export const CANCEL_TIMEOUT_MS = 10_000;
export const POLL_FIRST_MS = 2_000;
export const POLL_MAX_MS = 30_000;
export const TASK_MAX_MS = 6 * 60 * 60_000;
/** Tries of a SendMessage whose connection never opened. One that opened is never sent again. */
export const SEND_TRIES = 3;
/** Hand-offs to one peer open at one time. One more fails at once and is not sent. */
export const RUNNING_MAX = ADMIT.open;
/** SendMessage requests to one peer in each ADMIT.windowMs. */
export const SENDS_MAX = ADMIT.perWindow;
export const DESCRIPTION_MAX = 400;

/** Why the far agent cannot be used now, in words for the admin. */
export const PROBLEM = {
  address: "The address of the A2A agent must be a public https address.",
  redirect: "The address of the A2A agent sends a redirect. Use the final address.",
  unreachable: "The A2A agent could not be reached. Check the address.",
  token: "The A2A agent did not take the token. Check the token.",
  card: "The address does not give an A2A agent card.",
  tooLarge: "The card of the A2A agent is too large.",
  noRpc: "The A2A agent offers no JSON-RPC address for A2A 1.0.",
  otherSite: "The card of the A2A agent names an address on another site, so it is not used.",
} as const;

/** What the requesting bot reads when the work did not end with the far agent's own answer. */
export const RESULT_TEXT = {
  busy: "Too much work waits on the A2A agent now, so this was not sent. Try again later.",
  notSent: "The A2A agent could not be reached, so the work was not sent.",
  noAnswer: "The work went to the A2A agent, but no usable answer came back. It was not sent again.",
  unread: "The work went to the A2A agent, but its answer cannot be read now.",
  token: "The A2A agent did not take the token, so the work did not start there.",
  refused: "The A2A agent refused the work.",
  failed: "The work failed at the A2A agent.",
  signIn: "The A2A agent needs a sign-in on its side before it can do this.",
  stoppedThere: "The A2A agent stopped the work.",
  stopped: "Stopped.",
  gone: "The A2A agent no longer knows this work.",
  tooLong: "The A2A agent did not finish within 6 hours, so this hand-off ended.",
  asks: "The A2A agent asks for more input. Hand it your answer in the same thread.",
  empty: "The A2A agent finished with no text.",
} as const;

export type A2aRequestFn = (url: URL, options: EgressOptions) => Promise<EgressResult>;

export interface A2aOutboundDeps {
  link: Pick<BotLink, "receive">;
  /** The peer's key on its guest link. */
  key: string;
  /** The peer's place on its link. Its id never changes, and its name is the admin's name for the peer. */
  place: { id: string; name: string };
  /** The address the admin set for the far agent, or null when the peer only calls this server. */
  url(): URL | null;
  /** The far agent's token, or null when it takes none. */
  token(): string | null;
  /** The peer's task index, shared with its inbound side. */
  tasks: TaskIndex;
  egress?: EgressDeps;
  request?: A2aRequestFn;
  now?: () => number;
  log?: (line: string) => void;
}

export interface A2aOutbound {
  /** Reads the far agent's card and tells the link about its teammate. A call in progress is shared. */
  connect(): Promise<void>;
  send(frame: HandoffFrame): void;
  /** Stops the hand-off here, asks the far agent to stop it too, and ends it on the link as stopped. */
  cancel(id: string): void;
  problem(): string | null;
  /** The JSON-RPC address that the far agent's card names, or null. */
  endpoint(): string | null;
  /** Open hand-offs stop here, with no result and no request to the far agent. */
  close(): void;
}

type End = { ok: boolean; text: string; outcome?: string };
type Run = { id: string; thread: string; controller: AbortController; startedAt: number; delay: number; over: boolean; farTask?: string; timer?: ReturnType<typeof setTimeout> };
type RpcAnswer = { kind: "result"; result: unknown } | { kind: "error"; code: number; message: string } | { kind: "status"; status: number } | { kind: "garbled" };
type TextPart = { text?: string | undefined };

const SEND_BUDGET = "send";
/** The far states of a hand-off whose result the link has not had. The link also sends a cancel for a hand-off whose
 * result it took, and a far task that waits for input must live on after that cancel. */
const UNANSWERED: ReadonlySet<TaskState> = new Set(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"]);
const rpcAnswer = z.object({ result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
const cut = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
const oneLine = (text: string) => defuse(text).replace(/\s+/gu, " ").trim();

/** The description of the teammate: the card's description and its skill names. */
export function teammateDescription(card: FarCard): string | undefined {
  const skills = card.skills.map((skill) => oneLine(skill.name)).filter(Boolean);
  const text = oneLine([card.description, skills.length ? `Skills: ${skills.join(", ")}.` : ""].join(" "));
  return text ? cut(text, DESCRIPTION_MAX).trim() : undefined;
}

/** The card address: an address that names a .json file as it is, else the well-known card under its path. */
export function cardAddress(url: URL): URL {
  const card = new URL(url.href);
  card.hash = "";
  if (!card.pathname.endsWith(".json")) {
    card.pathname = `${card.pathname.replace(/\/+$/u, "")}/.well-known/agent-card.json`;
    card.search = "";
  }
  return card;
}

function joined(parts: readonly TextPart[]): string {
  const texts = parts.flatMap((part) => (typeof part.text === "string" ? [part.text] : []));
  const left = parts.length - texts.length;
  const note = left === 0 ? "" : `\n\n(${left} ${left === 1 ? "part that is" : "parts that are"} not text ${left === 1 ? "was" : "were"} left out.)`;
  const text = defuse(texts.join("\n")).trim();
  return text || note ? `${cut(text || RESULT_TEXT.empty, RESULT_TEXT_MAX - note.length)}${note}` : RESULT_TEXT.empty;
}
const outputOf = (task: FarTask): readonly TextPart[] => (task.artifacts?.length ? task.artifacts.flatMap((artifact) => artifact.parts) : task.status.message?.parts ?? []);
const farNote = (task: FarTask): string | undefined => {
  const text = defuse((task.status.message?.parts ?? []).flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("\n")).trim();
  return text ? cut(text, NOTE_MAX) : undefined;
};

export function createA2aOutbound(deps: A2aOutboundDeps): A2aOutbound {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const request: A2aRequestFn = deps.request ?? ((url, options) => a2aRequest(url, options, deps.egress));
  const sends = createFrameBudget(now, SENDS_MAX);
  const running = new Map<string, Run>();
  const cancels = new Set<AbortController>();
  const closer = new AbortController();
  let rpc: URL | null = null;
  let problem: string | null = null;
  let connecting: Promise<void> | null = null;
  let calls = 0;
  let closed = false;

  const authorization = (): Record<string, string> => { const token = deps.token(); return token ? { authorization: `Bearer ${token}` } : {}; };

  function hello(bots: LinkedBot[]): void {
    const frame = frameSchema.safeParse({ t: "hello", place: deps.place, bots });
    if (!frame.success) { log("a2a: the A2A agent's teammate did not fit a hello, so the directory is unchanged"); return; }
    deps.link.receive(deps.key, [frame.data]);
  }

  const broken = (text: string) => { rpc = null; problem = text; };
  function problemOf(error: unknown): string {
    if (!(error instanceof A2aEgressError)) return PROBLEM.unreachable;
    if (error.reason === "refused") return PROBLEM.address;
    if (error.reason === "redirect") return PROBLEM.redirect;
    if (error.reason === "too-large") return PROBLEM.tooLarge;
    return PROBLEM.unreachable;
  }

  async function readCard(): Promise<void> {
    const url = deps.url();
    if (!url) { rpc = null; problem = null; hello([]); return; }
    const card = cardAddress(url);
    let reply: EgressResult;
    try {
      reply = await request(card, { method: "GET", headers: { accept: "application/json", ...authorization() }, timeoutMs: CARD_TIMEOUT_MS, maxBytes: CARD_BODY_MAX, signal: closer.signal });
    } catch (error) {
      if (!closed) broken(problemOf(error));
      return;
    }
    if (closed) return;
    if (reply.status === 401 || reply.status === 403) { broken(PROBLEM.token); return; }
    if (reply.status !== 200) { broken(PROBLEM.card); return; }
    let parsed: ReturnType<typeof farCard.safeParse>;
    try { parsed = farCard.safeParse(JSON.parse(reply.body)); } catch { broken(PROBLEM.card); return; }
    if (!parsed.success) { broken(PROBLEM.card); return; }
    const found = jsonRpcInterface(parsed.data);
    let target: URL;
    try { target = new URL(found?.url ?? ""); } catch { broken(PROBLEM.noRpc); return; }
    if (target.origin !== card.origin || target.username || target.password) { broken(PROBLEM.otherSite); return; }
    target.hash = "";
    rpc = target;
    problem = null;
    const description = teammateDescription(parsed.data);
    hello([{ id: AGENT_ID, name: deps.place.name, ...(description ? { description } : {}) }]);
  }

  function connect(): Promise<void> {
    if (closed) return Promise.resolve();
    connecting ??= readCard().finally(() => { connecting = null; });
    return connecting;
  }

  async function call(method: string, params: unknown, signal: AbortSignal, timeoutMs = RPC_TIMEOUT_MS): Promise<RpcAnswer> {
    if (!rpc) return { kind: "status", status: 0 };
    calls += 1;
    const reply = await request(rpc, {
      method: "POST", timeoutMs, maxBytes: RPC_BODY_MAX, signal,
      headers: { "content-type": "application/json", accept: "application/json", "a2a-version": "1.0", ...authorization() },
      body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
    });
    if (reply.status === 401 || reply.status === 403) return { kind: "status", status: reply.status };
    let raw: unknown;
    try { raw = JSON.parse(reply.body); } catch { return reply.status === 200 ? { kind: "garbled" } : { kind: "status", status: reply.status }; }
    const parsed = rpcAnswer.safeParse(raw);
    if (!parsed.success) return reply.status === 200 ? { kind: "garbled" } : { kind: "status", status: reply.status };
    if (parsed.data.error) return { kind: "error", code: parsed.data.error.code, message: parsed.data.error.message };
    if (reply.status !== 200) return { kind: "status", status: reply.status };
    return parsed.data.result === undefined ? { kind: "garbled" } : { kind: "result", result: parsed.data.result };
  }

  function reply(id: string, end: End): void {
    deps.link.receive(deps.key, [{ t: "result", id, ok: end.ok, text: cut(end.text, RESULT_TEXT_MAX), ...(end.outcome ? { outcome: end.outcome } : {}) }]);
  }

  const outEntry = (id: string): TaskEntry | null => { const entry = deps.tasks.get(id); return entry?.dir === "out" ? entry : null; };

  function record(run: Run, state: TaskState, context?: string): void {
    const entry = outEntry(run.id);
    if (!entry) return;
    const farTaskId = run.farTask ?? entry.farTask;
    const nextContext = context ?? entry.context;
    if (entry.state === state && entry.farTask === farTaskId && entry.context === nextContext) return;
    deps.tasks.put({ ...entry, state, context: nextContext, ...(farTaskId ? { farTask: farTaskId } : {}), at: now() });
  }

  /** Ends a run once. "unsent" drops its index entry, since no request of it left. */
  function finish(run: Run, end: End, state: TaskState | "unsent"): void {
    if (run.over) return;
    run.over = true;
    clearTimeout(run.timer);
    running.delete(run.id);
    try {
      if (state !== "unsent") record(run, state);
      else if (outEntry(run.id)) deps.tasks.remove(run.id);
    } finally {
      reply(run.id, end);
    }
  }

  function cancelFar(task: string, connectFirst = true): void {
    if (closed) return;
    if (!rpc) {
      if (connectFirst) void connect().then(() => { cancelFar(task, false); });
      return;
    }
    const controller = new AbortController();
    cancels.add(controller);
    call("CancelTask", { id: task }, controller.signal, CANCEL_TIMEOUT_MS).catch(() => undefined).finally(() => { cancels.delete(controller); });
  }

  const pause = (run: Run, ms: number) => new Promise<void>((resolve) => {
    if (run.over) { resolve(); return; }
    run.timer = setTimeout(resolve, ms);
    run.controller.signal.addEventListener("abort", () => { resolve(); }, { once: true });
  });

  function schedule(run: Run): void {
    if (run.over || closed) return;
    const left = run.startedAt + TASK_MAX_MS - now();
    if (left <= 0) {
      if (run.farTask) cancelFar(run.farTask);
      finish(run, { ok: false, text: RESULT_TEXT.tooLong }, "TASK_STATE_FAILED");
      return;
    }
    const wait = Math.min(run.delay, left);
    run.delay = Math.min(run.delay * 2, POLL_MAX_MS);
    run.timer = setTimeout(() => { void guard(run, () => poll(run)); }, wait);
  }

  function settleTask(run: Run, task: FarTask): void {
    run.farTask = task.id;
    const state = task.status.state;
    const known = deps.tasks.outOf(run.thread);
    const far = task.contextId ?? known?.far ?? "";
    const inputTask = state === "TASK_STATE_INPUT_REQUIRED" ? task.id : undefined;
    if (known?.far !== far || known.inputTask !== inputTask) deps.tasks.setContext(run.thread, far, inputTask);
    record(run, state, far);
    switch (state) {
      case "TASK_STATE_SUBMITTED": case "TASK_STATE_WORKING": schedule(run); return;
      case "TASK_STATE_COMPLETED": finish(run, { ok: true, text: joined(outputOf(task)) }, state); return;
      case "TASK_STATE_INPUT_REQUIRED": {
        const question = farNote(task);
        finish(run, { ok: true, text: question ? `${RESULT_TEXT.asks}\n\n${question}` : RESULT_TEXT.asks }, state);
        return;
      }
      case "TASK_STATE_AUTH_REQUIRED": finish(run, { ok: false, text: RESULT_TEXT.signIn }, state); return;
      case "TASK_STATE_FAILED": finish(run, { ok: false, text: farNote(task) ?? RESULT_TEXT.failed }, state); return;
      case "TASK_STATE_REJECTED": finish(run, { ok: false, text: farNote(task) ?? RESULT_TEXT.refused, outcome: "refused" }, state); return;
      case "TASK_STATE_CANCELED": finish(run, { ok: false, text: RESULT_TEXT.stoppedThere, outcome: "stopped" }, state); return;
    }
  }

  function answered(run: Run, answer: RpcAnswer): void {
    if (answer.kind === "status") {
      if (answer.status === 401 || answer.status === 403) { problem = PROBLEM.token; finish(run, { ok: false, text: RESULT_TEXT.token }, "TASK_STATE_FAILED"); return; }
      finish(run, { ok: false, text: RESULT_TEXT.noAnswer }, "TASK_STATE_FAILED");
      return;
    }
    if (answer.kind === "error") {
      const said = cut(defuse(answer.message).trim(), NOTE_MAX);
      finish(run, { ok: false, text: said ? `${RESULT_TEXT.refused} It said: ${said}` : RESULT_TEXT.refused }, "TASK_STATE_REJECTED");
      return;
    }
    const result = answer.kind === "result" ? farSendResult.safeParse(answer.result) : null;
    if (!result?.success) { finish(run, { ok: false, text: RESULT_TEXT.noAnswer }, "TASK_STATE_FAILED"); return; }
    if (result.data.task) { settleTask(run, result.data.task); return; }
    const message = result.data.message!;
    const known = deps.tasks.outOf(run.thread);
    if (message.contextId && (known?.far !== message.contextId || known.inputTask !== undefined)) deps.tasks.setContext(run.thread, message.contextId);
    finish(run, { ok: true, text: joined(message.parts) }, "TASK_STATE_COMPLETED");
  }

  async function sendMessage(run: Run, text: string): Promise<RpcAnswer | null> {
    const context = deps.tasks.outOf(run.thread);
    const message = {
      messageId: run.id, role: "ROLE_USER", parts: [{ text }],
      ...(context?.far ? { contextId: context.far } : {}), ...(context?.inputTask ? { taskId: context.inputTask } : {}),
    };
    const params = { message, configuration: { acceptedOutputModes: ["text/plain"], returnImmediately: true } };
    deps.tasks.put({ id: run.id, dir: "out", bot: AGENT_ID, context: context?.far ?? "", thread: run.thread, state: "TASK_STATE_SUBMITTED", at: now() });
    for (let tries = 1; ; tries += 1) {
      try {
        return await call("SendMessage", params, run.controller.signal);
      } catch (error) {
        if (run.over) return null;
        const unsent = error instanceof A2aEgressError && !error.sent;
        if (unsent && (error.reason === "network" || error.reason === "timeout") && tries < SEND_TRIES) {
          await pause(run, POLL_FIRST_MS * tries);
          if (run.over) return null;
          continue;
        }
        if (error instanceof A2aEgressError && (error.reason === "refused" || error.reason === "redirect")) problem = problemOf(error);
        finish(run, { ok: false, text: unsent ? RESULT_TEXT.notSent : RESULT_TEXT.noAnswer }, unsent ? "unsent" : "TASK_STATE_FAILED");
        return null;
      }
    }
  }

  async function begin(run: Run, text: string): Promise<void> {
    if (!rpc) await connect();
    if (run.over) return;
    if (!rpc) { finish(run, { ok: false, text: problem ? `${problem} The work was not sent.` : RESULT_TEXT.notSent }, "unsent"); return; }
    const answer = await sendMessage(run, text);
    if (answer && !run.over) answered(run, answer);
  }

  /** A hand-off the link sends again, which the index already holds: its far task is read back, never sent again. */
  async function resume(run: Run, entry: TaskEntry): Promise<void> {
    if (!entry.farTask) { finish(run, { ok: false, text: RESULT_TEXT.noAnswer }, isTerminal(entry.state) ? entry.state : "TASK_STATE_FAILED"); return; }
    run.farTask = entry.farTask;
    if (!rpc) await connect();
    if (run.over) return;
    if (!rpc) { finish(run, { ok: false, text: problem ? `${problem} ${RESULT_TEXT.unread}` : RESULT_TEXT.unread }, entry.state); return; }
    await poll(run);
  }

  async function poll(run: Run): Promise<void> {
    if (run.over || closed || !run.farTask) return;
    let answer: RpcAnswer;
    try { answer = await call("GetTask", { id: run.farTask, historyLength: 0 }, run.controller.signal); } catch {
      schedule(run);
      return;
    }
    if (run.over) return;
    if (answer.kind === "error" && answer.code === ERR.TASK_NOT_FOUND) { finish(run, { ok: false, text: RESULT_TEXT.gone }, "TASK_STATE_FAILED"); return; }
    const task = answer.kind === "result" ? farTask.safeParse(answer.result) : null;
    if (!task?.success || task.data.id !== run.farTask) { schedule(run); return; }
    settleTask(run, task.data);
  }

  /** A step of one hand-off that throws ends it as failed, so no hand-off waits forever. */
  async function guard(run: Run, step: () => Promise<void>): Promise<void> {
    try { await step(); } catch (error) {
      log(`a2a: an outbound hand-off failed (${error instanceof Error ? error.message : String(error)})`);
      finish(run, { ok: false, text: RESULT_TEXT.noAnswer }, "TASK_STATE_FAILED");
    }
  }

  return {
    connect,
    send(frame) {
      if (closed || running.has(frame.id)) return;
      const known = outEntry(frame.id);
      if (running.size >= RUNNING_MAX || (!known && sends.left(SEND_BUDGET) < 1)) {
        reply(frame.id, { ok: false, text: known ? RESULT_TEXT.unread : RESULT_TEXT.busy });
        return;
      }
      const run: Run = { id: frame.id, thread: frame.thread, controller: new AbortController(), startedAt: now(), delay: POLL_FIRST_MS, over: false };
      running.set(frame.id, run);
      if (known) { void guard(run, () => resume(run, known)); return; }
      sends.spend(SEND_BUDGET, 1);
      void guard(run, () => begin(run, frame.text));
    },
    cancel(id) {
      if (closed) return;
      const run = running.get(id);
      if (run) {
        run.controller.abort();
        if (run.farTask) cancelFar(run.farTask);
        finish(run, { ok: false, text: RESULT_TEXT.stopped, outcome: "stopped" }, "TASK_STATE_CANCELED");
        return;
      }
      const known = outEntry(id);
      if (known?.farTask && UNANSWERED.has(known.state)) {
        cancelFar(known.farTask);
        deps.tasks.put({ ...known, state: "TASK_STATE_CANCELED", at: now() });
      }
      reply(id, { ok: false, text: RESULT_TEXT.stopped, outcome: "stopped" });
    },
    problem: () => problem,
    endpoint: () => rpc?.href ?? null,
    close() {
      if (closed) return;
      closed = true;
      closer.abort();
      for (const run of running.values()) { run.over = true; clearTimeout(run.timer); run.controller.abort(); }
      running.clear();
      for (const controller of cancels) controller.abort();
      cancels.clear();
    },
  };
}
