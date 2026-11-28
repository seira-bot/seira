type TodoApi = (path: string, init?: { method: string; body: string }) => Promise<Record<string, unknown>>;
type ToolAnswer = { text: string; isError?: boolean };

function rows(value: unknown): string[] {
  const list = Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];
  return list.map((todo) => `- ${String(todo.title)} (${String(todo.status)}${todo.botName ? `, @${String(todo.botName)}` : ", no bot yet"}) [todo id: ${String(todo.id)}]`);
}

function failed(what: string, r: Record<string, unknown>): ToolAnswer {
  return { text: `${what}: ${String(r.error)}`, isError: true };
}

/** todo_add, todo_list, todo_assign and todo_update: each goes to the server, which runs the same rules as the Board. */
export async function callTodoTool(name: string, args: Record<string, unknown>, api: TodoApi, me: { botId: string; threadId: string }): Promise<ToolAnswer> {
  const post = (path: string, body: Record<string, unknown>) => api(path, { method: "POST", body: JSON.stringify({ fromBotId: me.botId, fromThreadId: me.threadId, ...body }) });
  if (name === "todo_list") {
    const query = new URLSearchParams({ fromBotId: me.botId, fromThreadId: me.threadId });
    if (typeof args.status === "string") query.set("status", args.status);
    if (typeof args.assigneeBotId === "string") query.set("assigneeBotId", args.assigneeBotId);
    const r = await api(`/api/internal/todos?${query.toString()}`);
    if (r.error) return failed("Couldn't list the todos", r);
    const lines = rows(r.todos);
    return { text: lines.length ? `Todos:\n${lines.join("\n")}` : "No todos match." };
  }
  if (name === "todo_add") {
    const r = await post("/api/internal/todos", { todos: args.todos });
    if (r.error) return failed("Couldn't add the todos", r);
    const added = rows(r.added), existing = rows(r.existing);
    const refused = Array.isArray(r.refused) ? r.refused.map(String) : [];
    const parts = [
      added.length ? `Added ${added.length} ${added.length === 1 ? "todo" : "todos"}. The person sees them on the Board and in this chat:\n${added.join("\n")}` : "",
      existing.length ? `Already on the list, so not added again:\n${existing.join("\n")}` : "",
      refused.length ? `Not added:\n${refused.map((line) => `- ${line}`).join("\n")}` : "",
    ].filter(Boolean);
    return { text: parts.join("\n\n") || "Nothing was added.", ...(!added.length && !existing.length ? { isError: true } : {}) };
  }
  if (name === "todo_assign") {
    const r = await post("/api/internal/todos/assign", { todoId: args.todoId, assigneeBotId: args.assigneeBotId, reason: args.reason });
    if (r.error) return failed("Couldn't give that todo away", r);
    return { text: `Gave the todo to its bot:\n${rows([r.todo]).join("\n")}` };
  }
  const r = await post("/api/internal/todos/update", { todoId: args.todoId, status: args.status, title: args.title, note: args.note, result: args.result });
  if (r.error) return failed("Couldn't change that todo", r);
  return { text: `Updated the todo:\n${rows([r.todo]).join("\n")}` };
}
