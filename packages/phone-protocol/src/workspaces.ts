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
