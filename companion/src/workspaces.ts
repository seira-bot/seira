/** The workspaces of this computer, as a paired phone lists them and asks for one to open. The wire contract is
 * packages/phone-protocol/src/workspaces.ts (this build cannot import from that package; a test keeps the two in step).
 *
 * The desktop app owns the facts and the switch. The companion holds the last facts it was sent, answers both routes
 * itself, and passes a request for a switch back to the app, only for a workspace in its list. */

export const WORKSPACES_ROUTE = "/api/phones/self/workspaces";
export const WORKSPACE_SWITCH_ROUTE = "/api/phones/self/workspaces/switch";

export const WORKSPACES_MESSAGE = "seira:companion-workspaces";
export const WORKSPACE_SWITCH_MESSAGE = "seira:companion-workspace-switch";

const STATES = ["ready", "waiting", "unavailable"] as const;
const MAX_WORKSPACES = 50;

export interface Workspace {
  id: string;
  name?: string;
  color?: string;
  current: boolean;
  state: (typeof STATES)[number];
  waitingFor?: string;
}

export type WorkspaceSwitchAction = "open" | "hurry" | "cancel";

export interface WorkspaceReply {
  status: number;
  body: unknown;
}

export interface WorkspaceChannel {
  list(): Workspace[] | null;
  switchTo(request: Record<string, unknown>): Promise<WorkspaceReply>;
}

export type WorkspaceRoute = "list" | "switch";

export function workspaceRoute(method: string, path: string): WorkspaceRoute | null {
  if (method === "GET" && path === WORKSPACES_ROUTE) return "list";
  if (method === "POST" && path === WORKSPACE_SWITCH_ROUTE) return "switch";
  return null;
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
    out.push({ id, ...(name ? { name } : {}), ...(color ? { color } : {}), current, state, ...(waitingFor ? { waitingFor } : {}) });
  }
  return out;
}

/** A switch that starts answers with the list as it is a moment later, so a phone sees `waiting` at once; the wait is
 * bounded, and the phone gets the list as it is when the app does not answer in time. */
const SETTLE_MS = 1_500;

export function createWorkspaces({ send, settleMs = SETTLE_MS }: {
  send: (message: unknown) => void;
  settleMs?: number;
}): WorkspaceChannel & { receive(message: Record<string, unknown>): boolean } {
  let facts: Workspace[] | null = null;
  let waiters: Array<() => void> = [];

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
      if (message.type !== WORKSPACES_MESSAGE) return false;
      facts = cleanList(message.workspaces);
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) waiter();
      return true;
    },
    list: () => facts,
    async switchTo(request) {
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
      if (action) {
        const changed = nextFacts();
        send({ type: WORKSPACE_SWITCH_MESSAGE, action, id });
        await changed;
      }
      return { status: 200, body: { workspaces: facts ?? [] } };
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
): Promise<WorkspaceReply> {
  const absent: WorkspaceReply = { status: 404, body: { error: `no route: ${method} ${path}` } };
  const list = channel?.list();
  if (!channel || !list) return absent;
  const refused: WorkspaceReply = { status: 403, body: { error: "This phone cannot open other workspaces. Turn it on for this phone in Settings on the computer." } };
  if (route === "list") return { status: 200, body: { workspaces: allowed() ? list : list.filter((workspace) => workspace.current) } };
  if (!allowed()) return refused;
  let body: Record<string, unknown>;
  try {
    body = await readBody();
  } catch {
    return { status: 400, body: { error: "invalid request" } };
  }
  // The owner may have turned this phone off, or unpaired it, while the body was read.
  if (!allowed()) return refused;
  const reply = await channel.switchTo(body);
  // The switch waits for the desktop's next facts. A phone turned off or unpaired during that wait gets no list.
  if (!allowed()) return refused;
  return reply.status === 404 && (reply.body as { error?: string }).error === "no route" ? absent : reply;
}
