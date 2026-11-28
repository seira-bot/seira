import { randomBytes } from "node:crypto";

import { b64u, fromB64u } from "./e2e/credentials.ts";
import { NONCE_BYTES, PROOF_TTL_MS, switchProofMessage, type SwitchProofSigner } from "./e2e/switch-proof.ts";

/** The workspaces of this computer, as a paired phone lists them and asks for one to open. The wire contract is
 * packages/phone-protocol/src/workspaces.ts (this build cannot import from that package; a test keeps the two in step).
 *
 * The desktop app owns the facts and the switch. The companion holds the last facts it was sent, answers both routes
 * itself, and passes a request for a switch back to the app, only for a workspace in its list. */

export const WORKSPACES_ROUTE = "/api/phones/self/workspaces";
export const WORKSPACE_SWITCH_ROUTE = "/api/phones/self/workspaces/switch";

export const WORKSPACES_MESSAGE = "seira:companion-workspaces";
export const WORKSPACE_SWITCH_MESSAGE = "seira:companion-workspace-switch";
/** The desktop app tells the end of a switch with this message: `{ type, id: <operation id>, outcome }`. */
export const WORKSPACE_SWITCH_RESULT_MESSAGE = "seira:companion-workspace-switch-result";

const STATES = ["ready", "waiting", "unavailable"] as const;
const MAX_WORKSPACES = 50;
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A switch is kept for this long after it started, and no more than MAX_OPERATIONS at once, in memory only. */
const OPERATION_TTL_MS = 30 * 60_000;
const MAX_OPERATIONS = 50;
const OUTCOMES = ["done", "failed", "superseded", "cancelled"] as const;

export interface Workspace {
  id: string;
  environmentId?: string;
  name?: string;
  color?: string;
  current: boolean;
  state: (typeof STATES)[number];
  waitingFor?: string;
}

export type WorkspaceSwitchAction = "open" | "hurry" | "cancel";

export type SwitchState = "pending" | "done" | "failed" | "cancelled" | "superseded";

export interface WorkspaceSwitch {
  id: string;
  workspaceId: string;
  environmentId?: string;
  state: SwitchState;
}

export interface WorkspaceReply {
  status: number;
  body: unknown;
}

/** `owner`: the id of the paired phone that asks. A switch belongs to its owner, and no other phone reads it. */
export interface WorkspaceChannel {
  list(): Workspace[] | null;
  switchTo(request: Record<string, unknown>, owner: string): Promise<WorkspaceReply>;
  operation(id: string, owner: string): WorkspaceReply;
  /** The signed proof that a switch finished, once for each switch. The route, the nonce and the context are checked here. */
  proof(id: string, owner: string, request: Record<string, unknown>, context: ProofContext): WorkspaceReply;
}

/** What a proof needs from the encrypted connection that carries the request: its handshake hash, the id of the paired phone
 * that holds it, and the signer of the transport key. */
export interface ProofContext {
  deviceId: string;
  binding: Uint8Array;
  signer: SwitchProofSigner;
}

export type WorkspaceRoute = "list" | "switch" | "operation" | "proof";

export function workspaceRoute(method: string, path: string): WorkspaceRoute | null {
  if (method === "GET" && path === WORKSPACES_ROUTE) return "list";
  if (method === "POST" && path === WORKSPACE_SWITCH_ROUTE) return "switch";
  if (method === "GET" && path.startsWith(`${WORKSPACE_SWITCH_ROUTE}/`) && !path.slice(WORKSPACE_SWITCH_ROUTE.length + 1).includes("/")) return "operation";
  if (method === "POST" && path.startsWith(`${WORKSPACE_SWITCH_ROUTE}/`) && path.endsWith("/proof") && !path.slice(WORKSPACE_SWITCH_ROUTE.length + 1, -"/proof".length).includes("/")) return "proof";
  return null;
}

/** The operation id the read route names, or "" for an id that cannot be one (so it answers 404 like an unknown id). */
function operationIdOf(path: string): string {
  try {
    const id = decodeURIComponent(path.slice(WORKSPACE_SWITCH_ROUTE.length + 1).replace(/\/proof$/, ""));
    return /^[0-9a-f]{32}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? [...value].slice(0, limit).join("") : undefined;

/** What the app sent, cleaned: no entry without an id, no repeated id, one current workspace at most. Anything beyond
 * the fields of the contract is dropped, so a path or an address the app sent by mistake never reaches a phone. */
function cleanList(value: unknown): Workspace[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: Workspace[] = [];
  let currentSeen = false;
  for (const item of value) {
    if (out.length >= MAX_WORKSPACES) break;
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = text(raw.id, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = STATES.find((known) => known === raw.state) ?? "unavailable";
    const current = raw.current === true && !currentSeen;
    if (current) currentSeen = true;
    const name = text(raw.name, 80);
    const color = text(raw.color, 32);
    const waitingFor = state === "waiting" ? text(raw.waitingFor, 80) : undefined;
    const environmentId = typeof raw.environmentId === "string" && ENVIRONMENT_ID.test(raw.environmentId) ? raw.environmentId.toLowerCase() : undefined;
    out.push({ id, ...(environmentId ? { environmentId } : {}), ...(name ? { name } : {}), ...(color ? { color } : {}), current, state, ...(waitingFor ? { waitingFor } : {}) });
  }
  return out;
}

/** A switch that starts answers with the list as it is a moment later, so a phone sees `waiting` at once; the wait is
 * bounded, and the phone gets the list as it is when the app does not answer in time. */
const SETTLE_MS = 1_500;

interface Operation extends WorkspaceSwitch {
  owner: string;
  action: WorkspaceSwitchAction;
  startedAt: number;
  /** The workspace that was open when the switch started. */
  fromWorkspaceId?: string;
  fromEnvironmentId?: string;
  /** A switch has one proof: set when it is made. */
  proved?: boolean;
}

export function createWorkspaces({ send, settleMs = SETTLE_MS, now = Date.now, newId = () => randomBytes(16).toString("hex") }: {
  send: (message: unknown) => void;
  settleMs?: number;
  now?: () => number;
  newId?: () => string;
}): WorkspaceChannel & { receive(message: Record<string, unknown>): boolean } {
  let facts: Workspace[] | null = null;
  let waiters: Array<() => void> = [];
  // Insertion order is start order, so the oldest switch is the first entry.
  const operations = new Map<string, Operation>();

  function prune(): void {
    for (const [id, operation] of operations) if (now() - operation.startedAt > OPERATION_TTL_MS) operations.delete(id);
    while (operations.size > MAX_OPERATIONS) operations.delete(operations.keys().next().value as string);
  }

  const view = ({ id, workspaceId, environmentId, state }: Operation): WorkspaceSwitch => ({ id, workspaceId, ...(environmentId ? { environmentId } : {}), state });

  /** The desktop app tells how one switch ended, by its id. Only that switch changes: the app knows which switch it cancelled
   * or hurried, so nothing here guesses from the order of requests. An ended switch does not change again. */
  function finish(operation: Operation, outcome: (typeof OUTCOMES)[number]): void {
    if (operation.state === "pending") operation.state = outcome;
  }

  const nextFacts = (): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters = waiters.filter((waiter) => waiter !== done);
        resolve();
      };
      const timer = setTimeout(done, settleMs);
      waiters.push(done);
    });

  return {
    receive(message) {
      if (message.type === WORKSPACE_SWITCH_RESULT_MESSAGE) {
        const operation = typeof message.id === "string" ? operations.get(message.id) : undefined;
        const outcome = OUTCOMES.find((known) => known === message.outcome);
        if (operation && outcome) finish(operation, outcome);
        return true;
      }
      if (message.type !== WORKSPACES_MESSAGE) return false;
      facts = cleanList(message.workspaces);
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) waiter();
      return true;
    },
    list: () => facts,
    operation(id, owner) {
      prune();
      const operation = id ? operations.get(id) : undefined;
      if (!operation || operation.owner !== owner) return { status: 404, body: { error: "switch_not_found" } };
      return { status: 200, body: { switch: view(operation) } };
    },
    proof(id, owner, request, context) {
      prune();
      const operation = id ? operations.get(id) : undefined;
      if (!operation || operation.owner !== owner || owner !== context.deviceId) return { status: 404, body: { error: "switch_not_found" } };
      const nonce = typeof request.nonce === "string" ? fromB64u(request.nonce) : null;
      if (!nonce || nonce.length !== NONCE_BYTES) return { status: 400, body: { error: "invalid_nonce" } };
      if (operation.state !== "done") return { status: 409, body: { error: "switch_not_done" } };
      // The workspace that the switch named is the open one now, and it shows an environment id (the one it showed at the start, when it had one).
      const target = facts?.find((workspace) => workspace.id === operation.workspaceId);
      const environmentId = target?.current ? target.environmentId : undefined;
      if (operation.action === "cancel" || !operation.fromWorkspaceId || !environmentId || (operation.environmentId && operation.environmentId !== environmentId)) {
        return { status: 409, body: { error: "switch_not_provable" } };
      }
      if (operation.proved) return { status: 409, body: { error: "proof_used" } };
      const issuedAt = now();
      const expiresAt = Math.min(issuedAt + PROOF_TTL_MS, operation.startedAt + OPERATION_TTL_MS);
      const fields = {
        keyId: context.signer.keyId,
        binding: context.binding,
        deviceId: owner,
        operationId: operation.id,
        fromWorkspaceId: operation.fromWorkspaceId,
        ...(operation.fromEnvironmentId ? { fromEnvironmentId: operation.fromEnvironmentId } : {}),
        workspaceId: operation.workspaceId,
        environmentId,
        nonce,
        issuedAt,
        expiresAt,
      };
      const signature = context.signer.sign(switchProofMessage(fields));
      operation.proved = true;
      return {
        status: 200,
        body: {
          proof: {
            v: 1,
            operationId: fields.operationId,
            fromWorkspaceId: fields.fromWorkspaceId,
            ...(fields.fromEnvironmentId ? { fromEnvironmentId: fields.fromEnvironmentId } : {}),
            workspaceId: fields.workspaceId,
            environmentId,
            issuedAt,
            expiresAt,
            signature: b64u(signature),
          },
        },
      };
    },
    async switchTo(request, owner) {
      const list = facts;
      if (!list) return { status: 404, body: { error: "no route" } };
      const id = typeof request.id === "string" ? request.id : "";
      const target = list.find((workspace) => workspace.id === id);
      if (!target) return { status: 404, body: { error: "workspace_not_found" } };
      let action: WorkspaceSwitchAction | null = null;
      if (target.current) action = list.some((workspace) => workspace.state === "waiting") ? "cancel" : null;
      else if (target.state === "waiting") action = request.now === true ? "hurry" : null;
      else if (target.state === "ready") action = "open";
      else return { status: 409, body: { error: "workspace_unavailable" } };
      let operation: Operation | null = null;
      if (action) {
        const from = list.find((workspace) => workspace.current);
        operation = { id: newId(), owner, action, startedAt: now(), ...(from ? { fromWorkspaceId: from.id, ...(from.environmentId ? { fromEnvironmentId: from.environmentId } : {}) } : {}), workspaceId: id, ...(target.environmentId ? { environmentId: target.environmentId } : {}), state: "pending" };
        operations.set(operation.id, operation);
        // Trim after the insert, so the history never holds more than MAX_OPERATIONS.
        prune();
        const changed = nextFacts();
        send({ type: WORKSPACE_SWITCH_MESSAGE, action, id, operation: operation.id });
        await changed;
      }
      return { status: 200, body: { workspaces: facts ?? [], ...(operation ? { switch: view(operation) } : {}) } };
    },
  };
}

/** Answers one of the two routes. `readBody` reads the bounded JSON body of the switch request. `allowed` reads the owner's
 * choice for this phone from the live device record: off, it lists the current workspace only and refuses every switch.
 * It is a function, not a value, because the body is read after an await: a phone revoked while its request waits must
 * not switch, so the choice is read again right before the list is built and right before the switch. */
export async function answerWorkspaces(
  channel: WorkspaceChannel | undefined,
  route: WorkspaceRoute,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  allowed: () => boolean,
  owner: string,
  proof?: ProofContext,
): Promise<WorkspaceReply> {
  const absent: WorkspaceReply = { status: 404, body: { error: `no route: ${method} ${path}` } };
  const list = channel?.list();
  if (!channel || !list) return absent;
  const refused: WorkspaceReply = { status: 403, body: { error: "This phone cannot open other workspaces. Turn it on for this phone in Settings on the computer." } };
  if (route === "list") return { status: 200, body: { workspaces: allowed() ? list : list.filter((workspace) => workspace.current) } };
  if (!allowed()) return refused;
  if (route === "operation") return channel.operation(operationIdOf(path), owner);
  let body: Record<string, unknown>;
  try {
    body = await readBody();
  } catch {
    return { status: 400, body: { error: "invalid request" } };
  }
  // The owner may have turned this phone off, or unpaired it, while the body was read.
  if (!allowed()) return refused;
  if (route === "proof") return proof ? channel.proof(operationIdOf(path), owner, body, proof) : { status: 403, body: { error: "secure_channel_required" } };
  const reply = await channel.switchTo(body, owner);
  // The switch waits for the desktop's next facts. A phone turned off or unpaired during that wait gets no list.
  if (!allowed()) return refused;
  return reply.status === 404 && (reply.body as { error?: string }).error === "no route" ? absent : reply;
}
