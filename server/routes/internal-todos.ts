import type { Todo } from "../../shared/todo.ts";
import { TodoError, type TodosHost } from "../host/todos-host.ts";
import { publicTodo, type TodoPerson, type TodoRecord } from "../todos.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface InternalTodoDeps {
  host: TodosHost;
  from: { id: string };
  fromThreadId: string;
  /** Whom the calling conversation works for: a todo the bot adds opens its own conversation as them. */
  person?: () => TodoPerson;
  /** The caller's body, read only while its turn still holds the capability. */
  readBody(): Promise<unknown>;
  /** Whether the calling turn may read this todo: on a Team Cloud, only what the conversations it may read hold. */
  readable(todo: TodoRecord): boolean;
  botName(botId: string): string | undefined;
  /** Puts one line in the calling conversation. */
  postLine(threadId: string, text: string, todoIds: string[]): void;
}

function view(todo: Todo, botName: (id: string) => string | undefined) {
  return {
    id: todo.id, title: todo.title, status: todo.status, ...(todo.note ? { note: todo.note } : {}),
    ...(todo.botId ? { botId: todo.botId, botName: botName(todo.botId) ?? todo.botId } : {}),
    ...(todo.question ? { question: todo.question } : {}), ...(todo.result ? { result: todo.result } : {}),
  };
}

export function batchLine(todos: readonly Todo[], botName: (id: string) => string | undefined): string {
  const rows = todos.map((todo) => `- ${todo.title} (${todo.botId ? botName(todo.botId) ?? "a bot" : "no bot yet"})`);
  return `Added ${todos.length} ${todos.length === 1 ? "todo" : "todos"}:\n${rows.join("\n")}`;
}

/** The todo tools of a bot. Only dispatch inside the internal capability gate: the caller is the capability's own bot and conversation. */
export function createInternalTodoRoutes(deps: InternalTodoDeps): RouteHandler {
  const caller = { botId: deps.from.id, threadId: deps.fromThreadId };
  return async ({ res, path, method, url, json }) => {
    if (path !== "/api/internal/todos" && !path.startsWith("/api/internal/todos/")) return PASS;
    try {
      if (method === "GET" && path === "/api/internal/todos") {
        const found = deps.host.botList({ status: url.searchParams.get("status") ?? undefined, assigneeBotId: url.searchParams.get("assigneeBotId") ?? undefined }, deps.readable);
        return json(res, 200, { todos: found.slice(0, 100).map((todo) => view(publicTodo(todo), deps.botName)) });
      }
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const body = (await deps.readBody()) as Record<string, unknown> | null;
      if (path === "/api/internal/todos") {
        const added = deps.host.botAdd(caller, body?.todos, deps.person?.(), deps.readable);
        const fresh = added.todos.map(publicTodo);
        if (fresh.length) deps.postLine(caller.threadId, batchLine(fresh, deps.botName), fresh.map((todo) => todo.id));
        return json(res, 200, {
          added: fresh.map((todo) => view(todo, deps.botName)),
          existing: added.existing.map((todo) => view(publicTodo(todo), deps.botName)),
          refused: added.refused,
        });
      }
      if (path === "/api/internal/todos/assign") return json(res, 200, { todo: view(publicTodo(deps.host.botAssign(caller, body ?? {}, deps.readable)), deps.botName) });
      if (path === "/api/internal/todos/update") return json(res, 200, { todo: view(publicTodo(deps.host.botUpdate(caller, body ?? {}, deps.readable)), deps.botName) });
      return json(res, 404, { error: "no such route" });
    } catch (error) {
      if (error instanceof TodoError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
