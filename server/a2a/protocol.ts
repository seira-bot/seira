// Wire shapes of the Agent2Agent protocol 1.0 over JSON-RPC (text parts only). Shapes that come from a far agent drop
// unknown fields instead of failing, so a far agent may add fields. Shapes that this server relies on are bounded.
import { z } from "zod";

import { BRIEF_MAX } from "../bot-link/protocol.ts";
import type { HandoffStatus } from "../coordinator.ts";

export const A2A_PREFIX = "/api/a2a/";
export const HOLD_MS = 55_000;
export const CONTEXTS_MAX = 50;
export const TEXT_MAX = BRIEF_MAX;
export const RESULT_TEXT_MAX = 200_000;
export const NOTE_MAX = 2_000;
export const CARD_BODY_MAX = 64 * 1024;
export const RPC_BODY_MAX = 512 * 1024;
export const INBOUND_BODY_MAX = 64 * 1024;
/** Spec section 9.5 names no HTTP status for a JSON-RPC error, so an error travels in a 200 answer. */
export const RPC_HTTP_STATUS = 200;

export const TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
] as const;
export type TaskState = typeof TASK_STATES[number];

const TERMINAL: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED",
]);
export const isTerminal = (state: TaskState): boolean => TERMINAL.has(state);

/** Codes of spec sections 5.4 and 9.5. */
export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  VERSION_NOT_SUPPORTED: -32009,
} as const;
export type ErrorCode = typeof ERR[keyof typeof ERR];

const ERROR_TEXT: Record<ErrorCode, { message: string; reason?: string }> = {
  [ERR.PARSE]: { message: "Invalid JSON payload" },
  [ERR.INVALID_REQUEST]: { message: "Request payload validation error" },
  [ERR.METHOD_NOT_FOUND]: { message: "Method not found" },
  [ERR.INVALID_PARAMS]: { message: "Invalid parameters" },
  [ERR.INTERNAL]: { message: "Internal error" },
  [ERR.TASK_NOT_FOUND]: { message: "Task not found", reason: "TASK_NOT_FOUND" },
  [ERR.TASK_NOT_CANCELABLE]: { message: "Task cannot be canceled", reason: "TASK_NOT_CANCELABLE" },
  [ERR.PUSH_NOT_SUPPORTED]: { message: "Push notifications are not supported", reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" },
  [ERR.UNSUPPORTED_OPERATION]: { message: "This operation is not supported", reason: "UNSUPPORTED_OPERATION" },
  [ERR.CONTENT_TYPE_NOT_SUPPORTED]: { message: "Only text parts are supported", reason: "CONTENT_TYPE_NOT_SUPPORTED" },
  [ERR.VERSION_NOT_SUPPORTED]: { message: "Protocol version not supported", reason: "VERSION_NOT_SUPPORTED" },
};

const rpcId = z.union([z.string().max(256), z.number().finite()]);
export type RpcId = string | number | null;

export const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcId,
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof rpcRequest>;

const emptyAsUndefined = (value: string | undefined): string | undefined => (value === "" ? undefined : value);

const partOf = (textMax: number) => z.looseObject({ text: z.string().max(textMax).optional() });
const part = partOf(TEXT_MAX);
export type Part = z.infer<typeof part>;

const messageOf = (textMax: number) => z.object({
  messageId: z.string().min(1).max(200),
  role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
  parts: z.array(partOf(textMax)).min(1).max(20),
  contextId: z.string().max(256).optional().transform(emptyAsUndefined),
  taskId: z.string().max(256).optional().transform(emptyAsUndefined),
});
const message = messageOf(TEXT_MAX);
export type A2aMessage = z.infer<typeof message>;

const configuration = z.object({
  acceptedOutputModes: z.array(z.string().max(100)).max(20).optional(),
  historyLength: z.number().int().min(0).max(100).optional(),
  returnImmediately: z.boolean().optional(),
  // 1.0 names the field taskPushNotificationConfig; 0.3 clients send pushNotificationConfig.
  taskPushNotificationConfig: z.unknown().optional(),
  pushNotificationConfig: z.unknown().optional(),
});

export const sendMessageParams = z.object({ message, configuration: configuration.optional() });
export type SendMessageParams = z.infer<typeof sendMessageParams>;

export const getTaskParams = z.object({ id: z.string().min(1).max(256), historyLength: z.number().int().min(0).max(100).optional() });
export const cancelTaskParams = z.object({ id: z.string().min(1).max(256) });

/** Whether the configuration asks for push notifications, which this server does not offer. */
export function wantsPush(params: SendMessageParams): boolean {
  const config = params.configuration;
  return config !== undefined && (config.taskPushNotificationConfig != null || config.pushNotificationConfig != null);
}

export type TextOfParts = { kind: "text"; text: string } | { kind: "unsupported" } | { kind: "tooLong" };

/** The joined text of a message. Any part that is not plain text makes the whole message unsupported. */
export function textOfParts(parts: readonly Part[], max = TEXT_MAX): TextOfParts {
  const texts: string[] = [];
  for (const entry of parts) {
    if (typeof entry.text !== "string" || "raw" in entry || "url" in entry || "data" in entry) return { kind: "unsupported" };
    texts.push(entry.text);
  }
  const text = texts.join("\n");
  return text.length > max ? { kind: "tooLong" } : { kind: "text", text };
}

const timestamp = z.string().max(64);
const farMessage = messageOf(RESULT_TEXT_MAX);
const farArtifact = z.object({ artifactId: z.string().max(256).optional(), parts: z.array(partOf(RESULT_TEXT_MAX)).max(50) });

export const farTask = z.object({
  id: z.string().min(1).max(256),
  contextId: z.string().max(256).optional().transform(emptyAsUndefined),
  status: z.object({ state: z.enum(TASK_STATES), message: farMessage.optional(), timestamp: timestamp.optional() }),
  artifacts: z.array(farArtifact).max(50).optional(),
});
export type FarTask = z.infer<typeof farTask>;

/** The result of SendMessage: exactly one of task or message (spec section 9.4.1). */
export const farSendResult = z.object({ task: farTask.optional(), message: farMessage.optional() })
  .refine((result) => (result.task === undefined) !== (result.message === undefined));
export type FarSendResult = z.infer<typeof farSendResult>;

const farSkill = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).default(""),
});
const farInterface = z.object({
  url: z.string().min(1).max(2_048),
  protocolBinding: z.string().max(200),
  protocolVersion: z.string().max(32),
  tenant: z.string().max(256).optional(),
});

export const farCard = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).default(""),
  supportedInterfaces: z.array(farInterface).min(1).max(20),
  skills: z.array(farSkill).max(100).default([]),
});
export type FarCard = z.infer<typeof farCard>;

/** The JSON-RPC interface of version 1.x on a far card, or null when the card has none. */
export function jsonRpcInterface(card: FarCard): z.infer<typeof farInterface> | null {
  return card.supportedInterfaces.find((entry) => entry.protocolBinding === "JSONRPC" && /^1(\.\d+)*$/u.test(entry.protocolVersion)) ?? null;
}

/** An absent or empty A2A-Version header means 1.0 here. A present header must name major version 1. */
export function versionOk(header: string | string[] | undefined): boolean {
  const values = (Array.isArray(header) ? header : [header]).flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim()).filter((value) => value !== "");
  return values.every((value) => /^1(\.\d+)*$/u.test(value));
}

export type HandoffEnd = { ok: boolean; outcome?: string };

/** The state of an inbound task from its result frame, or from its hand-off status while no result exists. */
export function stateOf(done: HandoffEnd | null, status: HandoffStatus | undefined): TaskState {
  if (done) {
    if (done.ok) return "TASK_STATE_COMPLETED";
    if (done.outcome === "refused") return "TASK_STATE_REJECTED";
    if (done.outcome === "stopped") return "TASK_STATE_CANCELED";
    return "TASK_STATE_FAILED";
  }
  switch (status) {
    case "running": case "waiting": case "resume": return "TASK_STATE_WORKING";
    case "completed": return "TASK_STATE_COMPLETED";
    case "failed": return "TASK_STATE_FAILED";
    case "cancelled": return "TASK_STATE_CANCELED";
    default: return "TASK_STATE_SUBMITTED";
  }
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp: string; message?: { messageId: string; role: "ROLE_AGENT"; parts: { text: string }[] } };
  artifacts?: { artifactId: string; parts: { text: string }[] }[];
}

/** A task as the far client sees it. Result text becomes one artifact, and only for COMPLETED. */
export function taskView(task: { id: string; contextId: string; state: TaskState; text?: string; note?: string; at: number }): A2aTask {
  const view: A2aTask = {
    id: task.id,
    contextId: task.contextId,
    status: { state: task.state, timestamp: new Date(task.at).toISOString() },
  };
  if (task.note && (task.state === "TASK_STATE_FAILED" || task.state === "TASK_STATE_REJECTED")) {
    view.status.message = { messageId: `${task.id}:status`, role: "ROLE_AGENT", parts: [{ text: task.note.slice(0, NOTE_MAX) }] };
  }
  if (task.state === "TASK_STATE_COMPLETED" && task.text !== undefined) {
    view.artifacts = [{ artifactId: "result", parts: [{ text: task.text }] }];
  }
  return view;
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: { url: string; protocolBinding: "JSONRPC"; protocolVersion: "1.0" }[];
  capabilities: { streaming: false; pushNotifications: false; extendedAgentCard: false };
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer"; description: string } } };
  securityRequirements: { schemes: { bearer: { list: string[] } } }[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[] }[];
}

/** The card of one exposed bot (spec section 4.4). */
export function agentCard(input: { bot: { id: string; name: string; title?: string; description?: string }; endpoint: string }): AgentCard {
  const { bot } = input;
  const description = (bot.description?.trim() || bot.title?.trim() || bot.name).slice(0, 2_000);
  return {
    name: bot.name.slice(0, 200),
    description,
    version: "1",
    supportedInterfaces: [{ url: input.endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer", description: "A token from the owner of this server." } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: bot.id, name: bot.name.slice(0, 200), description, tags: [] }],
  };
}

export interface RpcErrorBody {
  jsonrpc: "2.0";
  id: RpcId;
  error: { code: ErrorCode; message: string; data?: { "@type": string; reason: string; domain: string }[] };
}

/** An error envelope. An A2A-specific code carries the ErrorInfo detail of spec section 9.5. */
export function rpcError(id: RpcId, code: ErrorCode, message?: string): RpcErrorBody {
  const known = ERROR_TEXT[code];
  const error: RpcErrorBody["error"] = { code, message: message ?? known.message };
  if (known.reason) error.data = [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: known.reason, domain: "a2a-protocol.org" }];
  return { jsonrpc: "2.0", id, error };
}

export function rpcResult<T>(id: RpcId, result: T): { jsonrpc: "2.0"; id: RpcId; result: T } {
  return { jsonrpc: "2.0", id, result };
}

/** An id for an error envelope: the request id when it is a string or a number, else null (JSON-RPC 2.0, section 5). */
export function idOf(raw: unknown): RpcId {
  const parsed = rpcId.safeParse(typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined);
  return parsed.success ? parsed.data : null;
}

/** The JSON-RPC envelope check of a decoded body: a batch is refused, and params stay unchecked. */
export function parseRequest(body: unknown): { ok: true; request: RpcRequest } | { ok: false; error: RpcErrorBody } {
  if (Array.isArray(body)) return { ok: false, error: rpcError(null, ERR.INVALID_REQUEST) };
  const parsed = rpcRequest.safeParse(body);
  if (parsed.success) return { ok: true, request: parsed.data };
  return { ok: false, error: rpcError(idOf(body), ERR.INVALID_REQUEST) };
}
