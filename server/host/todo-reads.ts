// Who may read a todo on a personal Cloud (one owner and guests). A Team Cloud reads by the audience rule
// (audience.ts), and a desktop has one person, so both read every todo here.
import type { RequestAuth } from "../request-auth.ts";
import type { TodoRecord } from "../todos.ts";

type SessionAuth = RequestAuth & { kind: "session" };

export interface TodoReadDeps {
  /** True on a personal Cloud: one owner and guests. */
  personal: boolean;
  /** The thread-starter key of nobody. */
  nobodyKey: string;
  /** The thread-starter key of work that came in from outside. */
  outsideKey: string;
  actorKey(auth: SessionAuth): string;
  /** A signed-in session with the owner's rights on this Cloud. */
  ownerSession(auth: RequestAuth): boolean;
  /** A conversation a guest drives, so its turns are confined. */
  guestDriven(threadId: string): boolean;
  /** A conversation that work from outside drives, so its turns are confined. */
  outsideDriven(threadId: string): boolean;
  /** The key a new conversation from this thread opens as: the person it works for. */
  openerFrom(threadId: string): string | undefined;
}

type Readable = Pick<TodoRecord, "threadId" | "source" | "person">;

export function createTodoReads(deps: TodoReadDeps) {
  const markers: ReadonlySet<string> = new Set([deps.nobodyKey, deps.outsideKey]);

  /** Security invariant: on a personal Cloud a guest sees only the todos they work for: the ones they wrote, and the
   * ones a bot made in their own conversation. The owner sees every todo, and so does the machine itself (loopback),
   * as with every other read. */
  function sessionMayRead(auth: RequestAuth, todo: Readable): boolean {
    if (!deps.personal || auth.kind !== "session" || deps.ownerSession(auth)) return true;
    return todo.person?.key === deps.actorKey(auth);
  }

  /** Security invariant: on a personal Cloud a confined turn (a guest's, or work from outside) reads, changes and closes
   * only the todos of its own conversation and of its own person. A marker key (nobody, outside) is no person, so
   * one piece of outside work never reads the todos of another. */
  function turnMayRead(threadId: string, todo: Readable): boolean {
    if (!deps.personal || !(deps.guestDriven(threadId) || deps.outsideDriven(threadId))) return true;
    if (todo.threadId === threadId || todo.source?.threadId === threadId) return true;
    const own = deps.openerFrom(threadId);
    return own !== undefined && !markers.has(own) && todo.person?.key === own;
  }

  return { sessionMayRead, turnMayRead };
}

export type TodoReads = ReturnType<typeof createTodoReads>;
