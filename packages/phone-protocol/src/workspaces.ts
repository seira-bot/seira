/** The workspaces of the computer a phone is paired with, version 1: the rail of the desktop app, as a phone lists it and
 * asks for one to open. The companion on the computer answers both routes itself; a computer without a companion, or whose
 * home is not this computer, answers 404 and the phone shows no picker.
 *
 * The list holds no folder path, address or port. */

export const PHONE_WORKSPACES_ROUTE = "/api/phones/self/workspaces";
export const PHONE_WORKSPACE_SWITCH_ROUTE = "/api/phones/self/workspaces/switch";

/** `ready`: can be opened. `waiting`: the computer opens it once the bot named in `waitingFor` finishes its turn.
 * `unavailable`: cannot be opened now. */
export const PHONE_WORKSPACE_STATES = ["ready", "waiting", "unavailable"] as const;
export type PhoneWorkspaceState = (typeof PHONE_WORKSPACE_STATES)[number];

export interface PhoneWorkspace {
  id: string;
  name?: string;
  color?: string;
  current: boolean;
  state: PhoneWorkspaceState;
  waitingFor?: string;
}

export interface PhoneWorkspaceList {
  workspaces: PhoneWorkspace[];
}

/** A `ready` workspace other than the current one: start the switch. A `waiting` workspace with `now`: open it at once.
 * The current workspace while a switch waits: cancel that switch. An unknown `id` answers 404 `workspace_not_found`. */
export interface PhoneWorkspaceSwitchRequest {
  id: string;
  now?: boolean;
}

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
    workspaces.push({
      id,
      ...(name ? { name } : {}),
      ...(color ? { color } : {}),
      current: raw.current === true,
      state,
      ...(waitingFor ? { waitingFor } : {}),
    });
  }
  return { workspaces };
}
