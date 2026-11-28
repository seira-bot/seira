/** The workspaces of the computer a phone is paired with, version 1: the rail of the desktop app, as a phone lists it and
 * asks for one to open. The companion on the computer answers both routes itself; a computer without a companion, or whose
 * home is not this computer, answers 404 and the phone shows no picker.
 *
 * The list holds no folder path, address or port. The computer owner lets each paired phone open other workspaces, off by
 * default: without it the list holds only the current workspace and the switch route answers 403. */

export const PHONE_WORKSPACES_ROUTE = "/api/phones/self/workspaces";
export const PHONE_WORKSPACE_SWITCH_ROUTE = "/api/phones/self/workspaces/switch";
/** The read route of one switch: `GET` this path with the operation `id` that the switch answered with. */
export const phoneWorkspaceSwitchStatusRoute = (id: string): string => `${PHONE_WORKSPACE_SWITCH_ROUTE}/${encodeURIComponent(id)}`;

/** `ready`: can be opened. `waiting`: the computer opens it once the bot named in `waitingFor` finishes its turn.
 * `unavailable`: cannot be opened now. */
export const PHONE_WORKSPACE_STATES = ["ready", "waiting", "unavailable"] as const;
export type PhoneWorkspaceState = (typeof PHONE_WORKSPACE_STATES)[number];

export interface PhoneWorkspace {
  id: string;
  /** The id that the environment of this workspace shows as its own (the `environmentId` of its descriptor). Absent when the
   * computer does not know it yet, as for a workspace that never ran. */
  environmentId?: string;
  name?: string;
  color?: string;
  current: boolean;
  state: PhoneWorkspaceState;
  waitingFor?: string;
}

export interface PhoneWorkspaceList {
  workspaces: PhoneWorkspace[];
}

/** `pending`: the switch waits or runs. `done`: the target workspace is open. `failed`: it could not open. `cancelled`: a cancel
 * request ended it. `superseded`: a newer switch took over. Only `pending` can change. */
export const PHONE_WORKSPACE_SWITCH_STATES = ["pending", "done", "failed", "cancelled", "superseded"] as const;
export type PhoneWorkspaceSwitchState = (typeof PHONE_WORKSPACE_SWITCH_STATES)[number];

/** One switch that the computer accepted. `id` is random and belongs to the phone that started the switch: no other phone reads
 * it. The computer keeps it for 30 minutes at most, then answers 404 `switch_not_found`. */
export interface PhoneWorkspaceSwitch {
  id: string;
  workspaceId: string;
  environmentId?: string;
  state: PhoneWorkspaceSwitchState;
}

/** The answer to a switch request: the list as it is a moment later, and `switch` when the computer started, hurried or
 * cancelled a switch. A request that changes nothing answers the list alone. A phone that reads only `workspaces` works as before. */
export interface PhoneWorkspaceSwitchResponse extends PhoneWorkspaceList {
  switch?: PhoneWorkspaceSwitch;
}

/** The answer of the read route. */
export interface PhoneWorkspaceSwitchStatus {
  switch: PhoneWorkspaceSwitch;
}

/** The proof read of one switch: `POST` this path inside the encrypted phone connection, with no bearer. See `PhoneWorkspaceSwitchProof`. */
export const phoneWorkspaceSwitchProofRoute = (id: string): string => `${PHONE_WORKSPACE_SWITCH_ROUTE}/${encodeURIComponent(id)}/proof`;

/** A `ready` workspace other than the current one: start the switch. A `waiting` workspace with `now`: open it at once.
 * The current workspace while a switch waits: cancel that switch. An unknown `id` answers 404 `workspace_not_found`. */
export interface PhoneWorkspaceSwitchRequest {
  id: string;
  now?: boolean;
}

const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const environmentIdOf = (value: unknown): string | undefined => (typeof value === "string" && ENVIRONMENT_ID.test(value) ? value.toLowerCase() : undefined);

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? [...value].slice(0, limit).join("") : undefined;

/** Reads a list from the wire. A state this build does not know reads as `unavailable`, and an entry without an id, or a
 * second entry with the same id, is dropped. */
export function parsePhoneWorkspaceList(value: unknown): PhoneWorkspaceList {
  const items = value && typeof value === "object" ? (value as { workspaces?: unknown }).workspaces : undefined;
  const seen = new Set<string>();
  const workspaces: PhoneWorkspace[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = text(raw.id, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = PHONE_WORKSPACE_STATES.find((known) => known === raw.state) ?? "unavailable";
    const name = text(raw.name, 80);
    const color = text(raw.color, 32);
    const waitingFor = state === "waiting" ? text(raw.waitingFor, 80) : undefined;
    const environmentId = environmentIdOf(raw.environmentId);
    workspaces.push({
      id,
      ...(environmentId ? { environmentId } : {}),
      ...(name ? { name } : {}),
      ...(color ? { color } : {}),
      current: raw.current === true,
      state,
      ...(waitingFor ? { waitingFor } : {}),
    });
  }
  return { workspaces };
}

/** Reads one switch from the wire: from the `switch` of a switch response, or of the read route. Null when it has no id or no
 * workspace id. A state this build does not know reads as `pending`, so an older phone keeps waiting and never reports a result
 * it does not understand. */
export function parsePhoneWorkspaceSwitch(value: unknown): PhoneWorkspaceSwitch | null {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const id = text(raw?.id, 128);
  const workspaceId = text(raw?.workspaceId, 128);
  if (!raw || !id || !workspaceId) return null;
  const state = PHONE_WORKSPACE_SWITCH_STATES.find((known) => known === raw.state) ?? "pending";
  const environmentId = environmentIdOf(raw.environmentId);
  return { id, workspaceId, ...(environmentId ? { environmentId } : {}), state };
}

/** The proof that a switch finished, version 1. After a switch the address shows another environment, so its own answer proves
 * nothing: a different server can copy a known `environmentId`. The phone moves its pin only on this proof, and only when the
 * signature verifies against the transport key `T.pub` that it pinned at pairing (companion/src/e2e/README.md, section 2).
 *
 * The phone sends `POST` `phoneWorkspaceSwitchProofRoute(id)` with a `PhoneWorkspaceSwitchProofRequest`, inside the encrypted
 * connection (the Noise session), and sends no bearer. The computer answers 200 `{ proof }` once for each switch, only when the
 * switch ended `done` for this phone, the phone may still open other workspaces, and the target workspace is the open one. An
 * answer made for another connection, or a second answer for the same switch, does not exist: it is 403 `secure_channel_required`,
 * 404 `switch_not_found`, 409 `switch_not_done`, 409 `switch_not_provable` or 409 `proof_used`. No proof, no pin change.
 *
 * Old computers answer 404 and old phones never ask: both keep today's behaviour. */
export interface PhoneWorkspaceSwitchProofRequest {
  /** b64u of 32 random bytes that the phone made for this request. */
  nonce: string;
}

export interface PhoneWorkspaceSwitchProof {
  v: 1;
  operationId: string;
  /** The workspace that was open when the switch started, and its environment when known. */
  fromWorkspaceId: string;
  fromEnvironmentId?: string;
  /** The workspace that is open now, and the environment it shows as its own. */
  workspaceId: string;
  environmentId: string;
  /** Milliseconds since the epoch, by the clock of the computer. The proof is short-lived. */
  issuedAt: number;
  expiresAt: number;
  /** b64u of the 64-byte ECDSA P-256 / SHA-256 signature (r ‖ s) over `phoneWorkspaceSwitchProofMessage`. */
  signature: string;
}

export const PHONE_SWITCH_PROOF_LABEL = "seira-switch-proof v1";

export interface PhoneWorkspaceSwitchProofFields {
  /** `SHA256(T.pub)[0:16]`. */
  keyId: Uint8Array;
  /** The handshake hash `h` of the Noise session that carries the proof (32 bytes). A proof for another session fails. */
  binding: Uint8Array;
  /** The id of the paired phone that asked: the phone knows it from pairing. */
  deviceId: string;
  operationId: string;
  fromWorkspaceId: string;
  fromEnvironmentId?: string;
  workspaceId: string;
  environmentId: string;
  /** The 32 bytes behind the request's `nonce`. */
  nonce: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}

const encoder = new TextEncoder();

/** The exact bytes that the computer signs: the label, a zero byte, then the fields in this order. A string is a 2-byte
 * big-endian length and its UTF-8 bytes (an absent `fromEnvironmentId` is the empty string); a time is 8 bytes big-endian. */
export function phoneWorkspaceSwitchProofMessage(fields: PhoneWorkspaceSwitchProofFields): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(PHONE_SWITCH_PROOF_LABEL), Uint8Array.of(0), fields.keyId, fields.binding];
  const string = (value: string) => {
    const bytes = encoder.encode(value);
    parts.push(Uint8Array.of(bytes.length >> 8, bytes.length & 255), bytes);
  };
  const time = (value: number) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
    parts.push(bytes);
  };
  string(fields.deviceId);
  string(fields.operationId);
  string(fields.fromWorkspaceId);
  string(fields.fromEnvironmentId ?? "");
  string(fields.workspaceId);
  string(fields.environmentId);
  parts.push(fields.nonce);
  time(fields.issuedAt);
  time(fields.expiresAt);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const wireTime = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** Reads a proof from the wire. Null when a field is missing or malformed: the phone then keeps its pin. Reading does not
 * verify anything; the phone checks the signature, the times, the nonce and the ids against what it asked for. */
export function parsePhoneWorkspaceSwitchProof(value: unknown): PhoneWorkspaceSwitchProof | null {
  const raw = value && typeof value === "object" ? ((value as { proof?: unknown }).proof as Record<string, unknown> | undefined) : undefined;
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const operationId = text(raw.operationId, 128);
  const fromWorkspaceId = text(raw.fromWorkspaceId, 128);
  const workspaceId = text(raw.workspaceId, 128);
  const environmentId = environmentIdOf(raw.environmentId);
  const issuedAt = wireTime(raw.issuedAt);
  const expiresAt = wireTime(raw.expiresAt);
  if (!operationId || !fromWorkspaceId || !workspaceId || !environmentId || issuedAt === undefined || expiresAt === undefined) return null;
  if (typeof raw.signature !== "string" || !SIGNATURE.test(raw.signature)) return null;
  const fromEnvironmentId = environmentIdOf(raw.fromEnvironmentId);
  return { v: 1, operationId, fromWorkspaceId, ...(fromEnvironmentId ? { fromEnvironmentId } : {}), workspaceId, environmentId, issuedAt, expiresAt, signature: raw.signature };
}
