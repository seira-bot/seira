// The inbound side of one A2A peer: the card of each bot exposed to it, and its JSON-RPC calls, each turned into a
// hand-off of the peer's guest link.
//
// Security: every request may come from a hostile party that holds a valid token. The token is checked before anything
// else, and only a wrong token counts as a failed try of its source. Each peer has a request budget, the link's frame
// budget and a limit on held requests; a context or task id the peer chooses is kept only in the bounded task index.
// The peer reads only fixed texts and the result of finished work, never a local error.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BotLink } from "../bot-link/link.ts";
import { guestFrameSchema, linkRoot, type ResultFrame } from "../bot-link/protocol.ts";
import type { Coordinator } from "../coordinator.ts";
import { json, readBody } from "../harness/http.ts";
import { ADMIT, BUSY_TEXT, createFrameBudget } from "../host/linked-servers-admit.ts";
import { defuse } from "../records-block.ts";
import { bearerToken, requestSource } from "../request-auth.ts";
import {
  A2A_PREFIX, CONTEXTS_MAX, ERR, HOLD_MS, INBOUND_BODY_MAX, NOTE_MAX, RESULT_TEXT_MAX, RPC_HTTP_STATUS, agentCard, cancelTaskParams, getTaskParams,
  isTerminal, parseRequest, rpcError, rpcResult, sendMessageParams, stateOf, taskView, textOfParts, versionOk, wantsPush,
  type A2aTask, type Cleaning, type ErrorCode, type RpcId, type TaskState,
} from "./protocol.ts";
import { frameId, threadKey, type TaskEntry, type TaskIndex } from "./tasks.ts";

/** The root card path. This server has no single agent, so it always answers 404 there. */
export const ROOT_CARD_PATH = "/.well-known/agent-card.json";
/** The requester's bot id in every hand-off from an A2A peer. */
export const CALLER_ID = "a2a-caller";
/** Requests one peer may make in each ADMIT.windowMs, of every kind. */
export const REQUESTS_MAX = 600;
/** Requests of one peer held open at one time. One more is answered at once. */
export const HOLDS_MAX = ADMIT.open;
/** How long CancelTask waits for the work to end before it answers. */
export const CANCEL_WAIT_MS = 2_000;

const ROUTE = /^([\w-]{1,128})(\/\.well-known\/agent-card\.json)?$/u;
const JSON_TYPE = /^application\/(?:a2a\+)?json\s*(?:;|$)/iu;
const PUSH_METHODS = /^(?:Create|Get|List|Delete)TaskPushNotificationConfigs?$/u;
const UNSUPPORTED_METHODS: ReadonlySet<string> = new Set(["GetExtendedAgentCard", "SendStreamingMessage", "SubscribeToTask", "ListTasks"]);
const RETRY_AFTER = String(Math.ceil(ADMIT.windowMs / 1_000));
const FALLBACK_NAME = "A2A agent";
const GONE = "The result is no longer kept.";
const NOT_VALID = { error: "The token is not valid." };
const TOO_MANY = { error: "Too many requests. Try again later." };
const NOT_FOUND = { error: "There is no such agent here." };
const NOT_ALLOWED = { error: "Method not allowed." };
const TOO_LARGE = { error: "The request is too large." };
const NOT_JSON = { error: "Send JSON." };

export interface A2aRequest { req: IncomingMessage; res: ServerResponse; path: string; method: string }
export interface InboundBot { id: string; name: string; title?: string; description?: string; hidden?: boolean; movedTo?: unknown }
/** The guest link's budget of work frames from this peer in the current window. */
export interface FrameBudget { left(): number; spend(frames: number): void }

export interface A2aInboundDeps {
  link: Pick<BotLink, "receive" | "has" | "ownsRoot">;
  /** The peer's key on its guest link. */
  key: string;
  /** The admin's name for the peer: the requester's name in every hand-off. */
  peerName(): string;
  exposed(botId: string): boolean;
  bot(id: string): InboundBot | null | undefined;
  /** The public JSON-RPC address of one bot, for its card. */
  endpoint(botId: string): string;
  coordinator(): Pick<Coordinator, "children">;
  tasks: TaskIndex;
  frames: FrameBudget;
  /** The characters of the peer's text that may be cleaned now. A call with no room is refused before it is read. */
  cleaning: Cleaning;
  /** The fixed text the peer reads for work that failed here. */
  failText: string;
  holdMs?: number;
  limits?: { requests?: number; holds?: number };
  now?: () => number;
}

export interface A2aInbound {
  /** The peer's link is on and this side is not closed. */
  live(): boolean;
  /** One request of the peer, already signed in, to one bot's card or JSON-RPC address. */
  handle(ctx: A2aRequest, botId: string, kind: "card" | "rpc"): Promise<void>;
  /** A result frame of the link for this peer: the task ends, held requests answer, and the link hears it was taken. */
  settled(id: string, frame: ResultFrame): void;
  /** Held requests end, and every later request of the peer gets 401. */
  close(): void;
}

/** Finds the peer of a token. Security invariant: it matches only A2A tokens, compared in constant time. */
export interface A2aGate {
  peerFor(token: string): A2aInbound | null | undefined;
  attemptAllowed(source: string): boolean;
  attemptFailed(source: string): void;
}

const unauthorized = (res: ServerResponse) => { res.setHeader("www-authenticate", "Bearer"); json(res, 401, NOT_VALID); };

/** Answers the A2A paths and the root card path. False: not an A2A request. */
export async function serveA2a(ctx: A2aRequest, gate: A2aGate): Promise<boolean> {
  const { req, res, path } = ctx;
  if (path === ROOT_CARD_PATH) { req.resume(); res.setHeader("cache-control", "no-store"); json(res, 404, NOT_FOUND); return true; }
  if (!path.startsWith(A2A_PREFIX)) return false;
  res.setHeader("cache-control", "no-store");
  const token = bearerToken(req.headers.authorization);
  const inbound = token ? gate.peerFor(token) : undefined;
  if (!inbound) {
    req.resume();
    const source = `linked-server:${requestSource(req)}`;
    if (!gate.attemptAllowed(source)) { res.setHeader("retry-after", RETRY_AFTER); json(res, 429, TOO_MANY); return true; }
    gate.attemptFailed(source);
    unauthorized(res);
    return true;
  }
  if (!inbound.live()) { req.resume(); unauthorized(res); return true; }
  const route = ROUTE.exec(path.slice(A2A_PREFIX.length));
  if (!route) { req.resume(); json(res, 404, NOT_FOUND); return true; }
  await inbound.handle(ctx, route[1]!, route[2] ? "card" : "rpc");
  return true;
}

type Answer = { status?: number; retry?: boolean; body: unknown };
const failure = (id: RpcId, code: ErrorCode): Answer => ({ body: rpcError(id, code) });
const success = (id: RpcId, result: unknown): Answer => ({ body: rpcResult(id, result) });
const throttled = (id: RpcId): Answer => ({ status: 429, retry: true, body: rpcError(id, ERR.INTERNAL, BUSY_TEXT) });
const nextTurn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

export function createA2aInbound(deps: A2aInboundDeps): A2aInbound {
  const now = deps.now ?? Date.now;
  const holdMs = deps.holdMs ?? HOLD_MS;
  const holdsMax = deps.limits?.holds ?? HOLDS_MAX;
  const requests = createFrameBudget(now, deps.limits?.requests ?? REQUESTS_MAX);
  const waiters = new Map<string, Set<() => void>>();
  let holding = 0;
  let closed = false;

  const inTask = (id: string): TaskEntry | null => { const entry = deps.tasks.get(id); return entry?.dir === "in" ? entry : null; };
  const callerName = () => deps.peerName().trim().slice(0, 120) || FALLBACK_NAME;
  const offered = (bot: InboundBot | null | undefined): bot is InboundBot => Boolean(bot && !bot.hidden && !bot.movedTo && deps.exposed(bot.id));
  const childOf = (id: string) => deps.coordinator().children(linkRoot(id))[0];

  /** An open task's state comes from its hand-off here; only a result frame ends it. */
  function liveState(id: string): TaskState {
    const status = childOf(id)?.status;
    return status === undefined || status === "queued" || status === "source" ? "TASK_STATE_SUBMITTED" : "TASK_STATE_WORKING";
  }

  function view(id: string): A2aTask | null {
    const entry = inTask(id);
    if (!entry) return null;
    const state = isTerminal(entry.state) ? entry.state : liveState(id);
    const text = state === "TASK_STATE_COMPLETED" ? (childOf(id)?.result ?? GONE).slice(0, RESULT_TEXT_MAX) : undefined;
    const note = state === "TASK_STATE_FAILED" ? deps.failText : state === "TASK_STATE_REJECTED" ? entry.note ?? deps.failText : undefined;
    return taskView({ id, contextId: entry.context, state, at: entry.at, ...(text !== undefined ? { text } : {}), ...(note !== undefined ? { note } : {}) });
  }

  function hold(id: string, ms: number, res: ServerResponse): Promise<void> {
    if (ms <= 0 || closed || holding >= holdsMax || res.destroyed || res.writableEnded) return Promise.resolve();
    holding += 1;
    return new Promise<void>((resolve) => {
      let over = false;
      const done = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        res.off("close", done);
        const set = waiters.get(id);
        set?.delete(done);
        if (set?.size === 0) waiters.delete(id);
        holding -= 1;
        resolve();
      };
      const timer = setTimeout(done, ms);
      res.on("close", done);
      const set = waiters.get(id) ?? new Set<() => void>();
      set.add(done);
      waiters.set(id, set);
    });
  }
  const wake = (id: string) => { for (const done of waiters.get(id) ?? []) done(); };

  /** The task once it ends or `ms` pass, whichever is first. */
  async function settle(id: string, ms: number, res: ServerResponse): Promise<A2aTask | null> {
    const entry = inTask(id);
    if (entry && !isTerminal(entry.state)) await hold(id, ms, res);
    return view(id);
  }

  async function sendMessage(id: RpcId, raw: unknown, botId: string, res: ServerResponse): Promise<Answer> {
    const parsed = sendMessageParams.safeParse(raw);
    if (!parsed.success || parsed.data.message.role !== "ROLE_USER") return failure(id, ERR.INVALID_PARAMS);
    if (wantsPush(parsed.data)) return failure(id, ERR.PUSH_NOT_SUPPORTED);
    const { message, configuration } = parsed.data;
    if (message.taskId !== undefined) return failure(id, inTask(message.taskId) ? ERR.UNSUPPORTED_OPERATION : ERR.TASK_NOT_FOUND);
    const text = textOfParts(message.parts);
    if (text.kind === "unsupported") return failure(id, ERR.CONTENT_TYPE_NOT_SUPPORTED);
    if (text.kind === "tooLong") return failure(id, ERR.INVALID_PARAMS);
    const taskId = frameId(deps.key, message.messageId);
    const wait = configuration?.returnImmediately === true ? 0 : holdMs;
    if (inTask(taskId)) {
      const task = await settle(taskId, wait, res);
      return task ? success(id, { task }) : failure(id, ERR.INTERNAL);
    }
    const context = message.contextId ?? `seira-${botId}`;
    const thread = threadKey(botId, context);
    if (message.contextId !== undefined && !deps.tasks.hasThread(thread) && deps.tasks.threadCount() >= CONTEXTS_MAX) return failure(id, ERR.UNSUPPORTED_OPERATION);
    if (deps.frames.left() < 1 || !deps.cleaning.fits(text.text.length)) return throttled(id);
    deps.cleaning.spend(text.text.length);
    const brief = defuse(text.text);
    if (brief.trim() === "") return failure(id, ERR.INVALID_PARAMS);
    const frame = guestFrameSchema.safeParse({
      t: "handoff", id: taskId, to: botId, from: { botId: CALLER_ID, name: callerName(), threadId: thread }, thread, text: brief, mode: "work", origin: { kind: "outside" },
    });
    if (!frame.success) return failure(id, ERR.INVALID_PARAMS);
    deps.frames.spend(1);
    deps.link.receive(deps.key, [frame.data]);
    deps.tasks.put({ id: taskId, dir: "in", bot: botId, context, thread, state: "TASK_STATE_SUBMITTED", at: now() });
    await nextTurn();
    const entry = inTask(taskId);
    if (entry && !isTerminal(entry.state) && !deps.link.ownsRoot(linkRoot(taskId))) deps.tasks.remove(taskId);
    const task = await settle(taskId, wait, res);
    return task ? success(id, { task }) : failure(id, ERR.INTERNAL);
  }

  function getTask(id: RpcId, raw: unknown, botId: string): Answer {
    const parsed = getTaskParams.safeParse(raw);
    if (!parsed.success) return failure(id, ERR.INVALID_PARAMS);
    const task = inTask(parsed.data.id)?.bot === botId ? view(parsed.data.id) : null;
    return task ? success(id, task) : failure(id, ERR.TASK_NOT_FOUND);
  }

  async function cancelTask(id: RpcId, raw: unknown, botId: string, res: ServerResponse): Promise<Answer> {
    const parsed = cancelTaskParams.safeParse(raw);
    if (!parsed.success) return failure(id, ERR.INVALID_PARAMS);
    const entry = inTask(parsed.data.id);
    if (!entry || entry.bot !== botId) return failure(id, ERR.TASK_NOT_FOUND);
    if (isTerminal(entry.state)) return failure(id, ERR.TASK_NOT_CANCELABLE);
    if (deps.frames.left() < 1) return throttled(id);
    deps.frames.spend(1);
    deps.link.receive(deps.key, [{ t: "cancel", id: entry.id }]);
    await nextTurn();
    const task = await settle(entry.id, CANCEL_WAIT_MS, res);
    return task ? success(id, task) : failure(id, ERR.TASK_NOT_FOUND);
  }

  async function rpc(req: IncomingMessage, res: ServerResponse, botId: string): Promise<Answer | null> {
    if (!JSON_TYPE.test(String(req.headers["content-type"] ?? ""))) { req.resume(); json(res, 415, NOT_JSON); return null; }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > INBOUND_BODY_MAX) { req.resume(); json(res, 413, TOO_LARGE); return null; }
    let body: unknown;
    try { body = await readBody(req, INBOUND_BODY_MAX); } catch (error) {
      if ((error as { status?: unknown }).status === 413) { json(res, 413, TOO_LARGE); return null; }
      return failure(null, ERR.PARSE);
    }
    const parsed = parseRequest(body);
    if (!parsed.ok) return { body: parsed.error };
    const { id, method, params } = parsed.request;
    if (!versionOk(req.headers["a2a-version"])) return failure(id, ERR.VERSION_NOT_SUPPORTED);
    if (method === "SendMessage") return sendMessage(id, params, botId, res);
    if (method === "GetTask") return getTask(id, params, botId);
    if (method === "CancelTask") return cancelTask(id, params, botId, res);
    if (PUSH_METHODS.test(method)) return failure(id, ERR.PUSH_NOT_SUPPORTED);
    if (UNSUPPORTED_METHODS.has(method)) return failure(id, ERR.UNSUPPORTED_OPERATION);
    return failure(id, ERR.METHOD_NOT_FOUND);
  }

  const live = () => !closed && deps.link.has(deps.key);

  return {
    live,
    async handle({ req, res, method }, botId, kind) {
      res.setHeader("cache-control", "no-store");
      if (!live()) { req.resume(); unauthorized(res); return; }
      if (requests.left("peer") < 1) { req.resume(); res.setHeader("retry-after", RETRY_AFTER); json(res, 429, TOO_MANY); return; }
      requests.spend("peer", 1);
      const bot = deps.bot(botId);
      if (!offered(bot)) { req.resume(); json(res, 404, NOT_FOUND); return; }
      if (kind === "card") {
        req.resume();
        if (method !== "GET") { json(res, 405, NOT_ALLOWED); return; }
        json(res, 200, agentCard({ bot, endpoint: deps.endpoint(bot.id) }));
        return;
      }
      if (method !== "POST") { req.resume(); json(res, 405, NOT_ALLOWED); return; }
      const answer = await rpc(req, res, bot.id);
      if (!answer || res.destroyed || res.writableEnded) return;
      if (!live()) { unauthorized(res); return; }
      if (answer.retry) res.setHeader("retry-after", RETRY_AFTER);
      json(res, answer.status ?? RPC_HTTP_STATUS, answer.body);
    },
    settled(id, frame) {
      const entry = inTask(id);
      if (entry && !isTerminal(entry.state)) {
        const state = stateOf({ ok: frame.ok, ...(frame.outcome ? { outcome: frame.outcome } : {}) }, undefined);
        const { note: _note, ...rest } = entry;
        deps.tasks.put({ ...rest, state, at: now(), ...(state === "TASK_STATE_REJECTED" && frame.text ? { note: frame.text.slice(0, NOTE_MAX) } : {}) });
      }
      deps.link.receive(deps.key, [{ t: "done", id }]);
      wake(id);
    },
    close() {
      closed = true;
      for (const id of waiters.keys()) wake(id);
    },
  };
}
