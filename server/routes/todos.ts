import { TODO_DONE_WINDOW_MS, type TodoDraft, type TodoMaker, type TodoPatch } from "../../shared/todo.ts";
import { atLeast } from "../../shared/bot-access.ts";
import type { Audience } from "../audience.ts";
import type { ThreadOwner, VisibleSet } from "../bot-visibility.ts";
import { TodoError, type TodosHost } from "../host/todos-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { TodoRunner } from "../todo-runner.ts";
import { publicTodo, todoVisible, type TodoPerson, type TodoRecord, type TodoStore } from "../todos.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TodoRouteDeps {
  store: TodoStore;
  host: TodosHost;
  runner: Pick<TodoRunner, "startNow" | "wake">;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  /** The bot or room that holds a conversation, from the server's own records; undefined for one it does not know. */
  threadOwner(threadId: string): ThreadOwner | undefined;
  personName: (auth: RequestAuth) => string;
  /** Runs `work` so that any repeating job it makes is checked and recorded as this person's. */
  withPerson<T>(auth: RequestAuth, work: () => T): T;
  /** Why this person may not change the repeating job of a todo; null when they may. */
  routineRefusal(auth: RequestAuth, routineId: string): string | null;
  /** Whom a todo this person writes works for: who they are, and the key its conversation opens as. */
  todoPerson(auth: RequestAuth): TodoPerson;
  /** Why this person may not change, start, delete or restore this todo; null when they may. The same rule as writing
   * in a conversation: on a Cloud a guest touches only their own. */
  changeRefusal(auth: RequestAuth, todo: TodoRecord): string | null;
  /** Whether the person it works for lets this person read it (on a personal Cloud a guest reads only their own).
   * Absent: yes. A todo this person may not read looks like a missing one. */
  readable?(auth: RequestAuth, todo: TodoRecord): boolean;
}

const ITEM = /^\/api\/todos\/([\w-]+)(\/start|\/restore)?$/;

function viewerOf(visible: VisibleSet) {
  return { bot: (botId: string) => visible.bot(botId), thread: (threadId: string) => visible.thread(threadId), audience: (audience: Audience) => visible.shows(audience) };
}

/** GET and POST /api/todos, PATCH, DELETE and POST …/start and …/restore on one todo, and PUT /api/todos/picker.
 * A todo the viewer cannot see looks like a missing one. */
export function createTodoRoutes(deps: TodoRouteDeps): RouteHandler {
  const { store, host } = deps;
  const mayChat = (visible: VisibleSet, botId: string | undefined) => !botId || atLeast(visible.level(botId), "chat");
  const sees = (visible: VisibleSet, auth: RequestAuth, todo: TodoRecord) => todoVisible(todo, viewerOf(visible)) && (deps.readable?.(auth, todo) ?? true);
  /** The bot whose chat level decides who may change a todo: its assignee, else the bot of the conversation it came from. */
  const ownerBot = (todo: Pick<TodoRecord, "botId" | "source">) => todo.botId ?? todo.source?.botId;

  /** A source the viewer may use: they see its conversation, and may chat with its bot. Its bot and room come from the
   * server's records of that conversation, never from what the client wrote. */
  function checkSource(visible: VisibleSet, source: TodoDraft["source"]): TodoDraft["source"] {
    if (source === undefined) return undefined;
    if (!source || typeof source.threadId !== "string" || !visible.thread(source.threadId)) throw new TodoError(400, "You cannot see the message this todo comes from.");
    const owner = deps.threadOwner(source.threadId);
    if (owner?.bot !== undefined && !mayChat(visible, owner.bot)) throw new TodoError(403, "You cannot add todos from this conversation.");
    return {
      threadId: source.threadId,
      ...(source.messageId !== undefined ? { messageId: source.messageId } : {}),
      ...(source.quote !== undefined ? { quote: source.quote } : {}),
      ...(owner?.bot !== undefined ? { botId: owner.bot } : {}),
      ...(owner?.group !== undefined ? { groupId: owner.group } : {}),
    };
  }

  /** A todo may wait only for a todo the viewer sees: the answer must not tell whether another todo is done. */
  function checkStart(visible: VisibleSet, auth: RequestAuth, start: { kind?: unknown; todoId?: unknown } | undefined | null): void {
    if (start?.kind !== "after") return;
    const other = typeof start.todoId === "string" ? store.get(start.todoId) : undefined;
    if (!other || !sees(visible, auth, other)) throw new TodoError(400, "That todo is not on your list.");
  }

  function seen(visible: VisibleSet, auth: RequestAuth, todo: TodoRecord | undefined): TodoRecord {
    if (!todo || !sees(visible, auth, todo)) throw new TodoError(404, "That todo is gone.");
    return todo;
  }

  function guardRoutine(auth: RequestAuth, routineId: string | undefined): void {
    const refused = routineId ? deps.routineRefusal(auth, routineId) : null;
    if (refused) throw new TodoError(403, refused);
  }

  function guardChange(auth: RequestAuth, todo: TodoRecord): void {
    const refused = deps.changeRefusal(auth, todo);
    if (refused) throw new TodoError(403, refused);
  }

  function mayGive(visible: VisibleSet, botId: string): void {
    if (!visible.bot(botId)) throw new TodoError(400, "That bot is not on your team.");
    if (!mayChat(visible, botId)) throw new TodoError(403, "You cannot give work to this bot.");
  }

  return async ({ req, res, path, method, auth, json, readBody }) => {
    const isPicker = path === "/api/todos/picker";
    const item = isPicker ? null : ITEM.exec(path);
    if (path !== "/api/todos" && !isPicker && !item) return PASS;
    const visible = deps.visibleFor(auth);
    const person: TodoMaker = { kind: "person", name: deps.personName(auth) };
    try {
      if (path === "/api/todos") {
        if (method === "GET") {
          const cutoff = store.now() - TODO_DONE_WINDOW_MS;
          const todos = store.live().filter((todo) => sees(visible, auth, todo) && (todo.status !== "done" || (todo.finishedAt ?? todo.updatedAt) >= cutoff));
          const picker = host.picker();
          return json(res, 200, { todos: todos.map(publicTodo), picker: picker !== null && visible.bot(picker) ? picker : null });
        }
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const body = (await readBody(req)) as { todos?: unknown } | null;
        if (!Array.isArray(body?.todos)) throw new TodoError(400, "Send the todos to add.");
        const drafts = (body.todos as TodoDraft[]).map((draft) => {
          if (draft?.botId) mayGive(visible, draft.botId);
          checkStart(visible, auth, draft?.start);
          const source = checkSource(visible, draft?.source);
          return source === undefined ? draft : { ...draft, source };
        });
        const added = deps.withPerson(auth, () => host.add(drafts, person, { person: deps.todoPerson(auth) }));
        return json(res, 200, { todos: added.todos.map(publicTodo) });
      }
      if (isPicker) {
        if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
        const body = (await readBody(req)) as { botId?: unknown } | null;
        if (!body || (body.botId !== null && typeof body.botId !== "string")) throw new TodoError(400, "Pick a bot, or nobody.");
        if (typeof body.botId === "string" && !visible.bot(body.botId)) throw new TodoError(400, "That bot is not on your team.");
        const picker = host.setPicker(body.botId);
        return json(res, 200, { picker });
      }
      const [, id, action] = item!;
      if (action === "/restore") {
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const gone = store.getDeleted(id!);
        if (gone && (!sees(visible, auth, gone) || !mayChat(visible, ownerBot(gone)))) throw new TodoError(404, "That todo is gone.");
        if (gone) guardChange(auth, gone);
        guardRoutine(auth, gone?.routineId);
        return json(res, 200, { todo: publicTodo(deps.withPerson(auth, () => host.restore(id!))) });
      }
      const current = seen(visible, auth, store.get(id!));
      if (action === "/start") {
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (!mayChat(visible, ownerBot(current))) throw new TodoError(403, "You cannot start work for this bot.");
        guardChange(auth, current);
        return json(res, 200, { todo: publicTodo(await deps.runner.startNow(current.id)) });
      }
      if (method === "DELETE") {
        if (!mayChat(visible, ownerBot(current))) throw new TodoError(403, "You cannot change this bot's todos.");
        guardChange(auth, current);
        guardRoutine(auth, current.routineId);
        host.remove(current.id);
        return json(res, 200, { ok: true });
      }
      if (method === "PATCH") {
        const body = (await readBody(req)) as TodoPatch | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new TodoError(400, "Send the change to make.");
        if (!mayChat(visible, ownerBot(current))) throw new TodoError(403, "You cannot change this bot's todos.");
        guardChange(auth, current);
        if (typeof body.botId === "string") mayGive(visible, body.botId);
        checkStart(visible, auth, body.start);
        guardRoutine(auth, current.routineId);
        return json(res, 200, { todo: publicTodo(deps.withPerson(auth, () => host.patch(current.id, body, person))) });
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      if (error instanceof TodoError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
