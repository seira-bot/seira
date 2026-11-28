// Who a todo works for, who may see, change and run it, and where a bot's todo may go. One rule for every step of a
// todo's life, so the Board, the todo routes, the runner, the picker and a bot's own turn all agree.
import { audienceMember, mayRead, TEAM_AUDIENCE, threadAudienceFrom, type Audience } from "../audience.ts";
import type { BotAccessLevel } from "../../shared/bot-access.ts";
import type { Viewer } from "../bot-visibility.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { TodoPerson, TodoRecord } from "../todos.ts";

type SessionAuth = RequestAuth & { kind: "session" };

export interface TodoPolicyDeps {
  /** "desktop" off a Cloud, "personal" for a Cloud of one owner and guests, "team" for a Team Cloud. */
  mode: "desktop" | "personal" | "team";
  /** The thread-starter key of nobody: the least a conversation may do. */
  nobodyKey: string;
  /** The thread-starter key of work that came in from outside. */
  outsideKey: string;
  actorKey(auth: SessionAuth): string;
  /** A signed-in session with the owner's rights on this Cloud. */
  ownerSession(auth: RequestAuth): boolean;
  /** A thread-starter key of the owner of this Cloud. */
  ownerPerson(key: string): boolean;
  viewerFor(auth: RequestAuth): Viewer;
  level(viewer: Viewer, botId: string): BotAccessLevel;
  /** The people of a Team Cloud, with their roles. */
  teamPeople(): ReadonlyArray<{ email: string; role?: string }>;
  /** The signed-in sessions of a personal Cloud. */
  signedIn(): ReadonlyArray<{ id: string; email?: string }>;
  audienceOf(threadId: string): Audience;
  readableFrom(threadId: string): (otherThreadId: string) => boolean;
  guestDriven(threadId: string): boolean;
  outsideDriven(threadId: string): boolean;
  /** Outside work that may not open a new conversation. */
  outsideStaysHere(threadId: string): boolean;
  /** The key a new conversation from this thread opens as. */
  openerFrom(threadId: string): string | undefined;
}

export function createTodoPolicy(deps: TodoPolicyDeps) {
  const cloud = deps.mode !== "desktop";
  const team = deps.mode === "team";
  const markers: ReadonlySet<string> = new Set([deps.nobodyKey, deps.outsideKey]);
  const audienceOfKey = (key: string | undefined): Audience => threadAudienceFrom({ room: null, starter: key, markers });

  /** What the person a todo works for may do with a bot now. A todo with nobody recorded counts as an anonymous member. */
  function levelFor(person: TodoPerson | undefined, botId: string): BotAccessLevel {
    const viewer = person?.viewer ?? { kind: "member" as const };
    if (!team || !viewer.email) return deps.level(viewer, botId);
    const role = deps.teamPeople().find((one) => one.email === viewer.email)?.role;
    return deps.level(role === "owner" || role === "admin" ? { kind: "all", email: viewer.email } : { kind: "member", email: viewer.email }, botId);
  }

  /** Whom a todo written through the Board works for. On a Cloud a bot's shell is nobody: it gets the least. */
  function personOf(auth: RequestAuth): TodoPerson {
    if (auth.kind === "session") return { key: deps.actorKey(auth), viewer: deps.viewerFor(auth) };
    return cloud ? { key: deps.nobodyKey, viewer: { kind: "member" } } : { viewer: deps.viewerFor(auth) };
  }

  /** The same rule as writing in a conversation: on a Cloud only the owner's devices, or the person whose todo it is. On a
   * Team Cloud a todo of a shared chat stays the team's. */
  function changeRefusal(auth: RequestAuth, todo: TodoRecord): string | null {
    if (!cloud || deps.ownerSession(auth)) return null;
    const key = todo.person?.key;
    if (auth.kind === "session" && (key === deps.actorKey(auth) || (team && (key === undefined || key === deps.nobodyKey)))) return null;
    return "On this Cloud you can only change todos you made.";
  }

  /** The person a thread-starter key names, as a viewer: on a Team Cloud from its people, else from a signed-in session.
   * None off a Cloud, and for nobody, outside work or no key. A person no longer known is a member with no email. */
  function viewerOf(key: string | undefined): Viewer | undefined {
    if (!cloud || !key || markers.has(key)) return undefined;
    if (deps.ownerPerson(key)) return { kind: "all" };
    const email = team
      ? deps.teamPeople().find((one) => personKey({ id: "", email: one.email }) === key)?.email
      : deps.signedIn().find((one) => personKey(one) === key)?.email;
    return { kind: "member", ...(email ? { email } : {}) };
  }

  /** Who may read a todo on a Team Cloud (docs/team-cloud.md, audience rule): a bot's todo has the audience of the
   * conversation it came from; a person's todo is that person's alone, as their private chat is. */
  function audience(todo: TodoRecord): Audience {
    return todo.madeBy.kind === "bot" && todo.source ? deps.audienceOf(todo.source.threadId) : audienceOfKey(todo.person?.key);
  }

  /** Security invariant: on a Team Cloud a todo's own conversation is read by no more people than the todo is, so a room's
   * todo never runs where the whole team reads it. */
  function mayRun(todo: TodoRecord): boolean {
    return !team || mayRead(audience(todo), audienceOfKey(todo.person?.key ?? deps.nobodyKey));
  }

  /** Security invariant: a person sees only todos they may read. On a Team Cloud a person's own todo is theirs alone (no
   * role sees another person's); on a personal Cloud a guest sees only their own, and the owner everything. */
  function sessionMayRead(auth: RequestAuth, todo: TodoRecord): boolean {
    if (!cloud) return true;
    if (team) {
      const person = audienceMember(audience(todo));
      return person === null || (auth.kind === "session" && deps.actorKey(auth) === person);
    }
    if (deps.ownerSession(auth)) return true;
    return auth.kind === "session" && todo.person?.key === deps.actorKey(auth);
  }

  /** Security invariant: a bot's turn reads or changes a todo only where it may read where the todo came from. On a Team
   * Cloud by the audience rule; on a personal Cloud a confined turn (a guest's or outside work) only its own
   * conversation's todos and its person's. A marker key (nobody, outside) is no person, so outside work never reads
   * another's todos. */
  function turnMayRead(threadId: string, todo: TodoRecord): boolean {
    if (team) {
      return mayRead(audience(todo), deps.audienceOf(threadId))
        && [todo.threadId, todo.source?.threadId].every((id) => id === undefined || deps.readableFrom(threadId)(id));
    }
    if (!cloud || !(deps.guestDriven(threadId) || deps.outsideDriven(threadId))) return true;
    const own = deps.openerFrom(threadId);
    return todo.threadId === threadId || todo.source?.threadId === threadId || (own !== undefined && !markers.has(own) && todo.person?.key === own);
  }

  /** The key a bot's todo opens its conversation as. Work from outside stays outside work (a routine it proposes is too). */
  function keyFrom(threadId: string): string | undefined {
    return cloud && (deps.outsideDriven(threadId) || deps.outsideStaysHere(threadId)) ? deps.outsideKey : deps.openerFrom(threadId);
  }

  /** Whom a bot's todo from this conversation works for: its person when the conversation is one person's, so every bot
   * the todo later goes to must be one they may chat with. */
  function botPerson(threadId: string): TodoPerson {
    const key = keyFrom(threadId);
    const viewer = viewerOf(key);
    return { ...(key ? { key } : {}), ...(viewer ? { viewer } : {}) };
  }

  /** Why a bot's turn may not add todos here. Outside work stays here, as it may not open a new conversation. On a Team
   * Cloud a todo's conversation must not reach more people than the one it came from (a room's would reach the team). */
  function addRefusal(threadId: string): string | null {
    if (cloud && deps.outsideStaysHere(threadId)) return "This work came in from outside, so it cannot add todos. Finish it here.";
    if (team && !mayRead(deps.audienceOf(threadId), audienceOfKey(keyFrom(threadId) ?? deps.nobodyKey))) {
      return "A todo from this conversation would run where more people can read it. Tell the people here instead.";
    }
    return null;
  }

  /** Security invariant: the picker's conversation is not confined, so work from outside never reaches it. On a personal
   * Cloud, where it runs as the owner's, neither does a guest's todo or one from a guest's conversation. On a Team Cloud
   * it is the team's, so it reads only the team's todos: a person's own todo, or one from a room, waits for a person. */
  function pickerMayRead(threadId: string | undefined, todo: TodoRecord): boolean {
    if (todo.person?.key === deps.outsideKey) return false;
    if (deps.mode === "personal") return todo.person !== undefined && (todo.person.key === undefined || deps.ownerPerson(todo.person.key));
    if (!team) return true;
    if (!mayRead(audience(todo), threadId ? deps.audienceOf(threadId) : TEAM_AUDIENCE)) return false;
    return todo.source === undefined || (threadId !== undefined && deps.readableFrom(threadId)(todo.source.threadId));
  }

  /** The key a todo's own conversation opens as: on a Cloud nobody's when none was recorded, so it is confined. */
  function openKey(todo: TodoRecord): string | undefined {
    return todo.person?.key ?? (cloud ? deps.nobodyKey : undefined);
  }

  return { levelFor, personOf, changeRefusal, viewerOf, audience, mayRun, sessionMayRead, turnMayRead, keyFrom, botPerson, addRefusal, pickerMayRead, openKey };
}

export type TodoPolicy = ReturnType<typeof createTodoPolicy>;
