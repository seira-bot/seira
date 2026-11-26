// Start, Hide and Show on a "Tasks I could help with" card (server/task-suggestions.ts). Open to anyone who may write in the
// conversation (client scope, like sending a message): Start sends the shown title as a typed line would, and Hide and Show
// change only how the card looks.
import { TASK_SUGGESTION_ACTIONS, type TaskSuggestionAction } from "../../packages/phone-protocol/src/task-suggestions.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message, Store } from "../store.ts";
import { answerTaskSuggestion, findTaskSuggestion } from "../task-suggestions.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { userError } from "../user-errors.ts";

export interface TaskSuggestionRouteDeps {
  store: Pick<Store, "bot" | "taskByThread" | "messagesFor" | "patchMessage">;
  /** The caller may see this conversation. */
  threadVisible(auth: RequestAuth, threadId: string): boolean;
  /** Why this caller may not write in this conversation (a Cloud guest in the owner's chat), or null. */
  sendRefusal(auth: RequestAuth, threadId: string): string | null;
  /** Sends the title in this conversation exactly as a typed message, starting (or queueing) its turn. A refusal throws an
   * error with its HTTP status. */
  send(auth: RequestAuth, botId: string, threadId: string, text: string): Promise<{ ok: true; message?: Message }>;
}

const PATH = /^\/api\/bots\/([\w-]+)\/task-suggestions$/;
const ID = /^[\w-]{1,128}$/;

export function createTaskSuggestionRoutes(deps: TaskSuggestionRouteDeps): RouteHandler {
  /** Cards whose Start is on its way: a second tap, another tab or another task on that card waits for it. */
  const starting = new Set<string>();
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = path.match(PATH);
    if (!m || method !== "POST") return PASS;
    const botId = m[1]!;
    const body = await readBody(req, 2048);
    const { threadId, messageId, suggestionId, action } = (body ?? {}) as Record<string, unknown>;
    if (typeof threadId !== "string" || !ID.test(threadId)) return json(res, 400, { error: "threadId is required" });
    if (typeof messageId !== "string" || !ID.test(messageId)) return json(res, 400, { error: "messageId is required" });
    if (typeof suggestionId !== "string" || !ID.test(suggestionId)) return json(res, 400, { error: "suggestionId is required" });
    if (typeof action !== "string" || !(TASK_SUGGESTION_ACTIONS as readonly string[]).includes(action)) return json(res, 400, { error: "action must be start, hide or show" });
    if (!deps.store.bot(botId)) return json(res, 404, { error: "no such bot" });
    const refused = deps.sendRefusal(auth, threadId);
    if (refused) return json(res, 403, { error: refused });
    if (!(deps.store.bot(botId)?.threadId === threadId || deps.store.taskByThread(botId, threadId)) || !deps.threadVisible(auth, threadId)) return json(res, 404, userError("serverError.taskSuggestion.missing"));
    const found = findTaskSuggestion(deps.store, threadId, messageId, suggestionId);
    if (!found) return json(res, 404, userError("serverError.taskSuggestion.missing"));
    const key = `${threadId}:${messageId}`;
    if (starting.has(key)) return json(res, 409, userError("serverError.chat.answerSent"));
    const choice = action as TaskSuggestionAction;
    if (choice !== "start") {
      const step = answerTaskSuggestion(deps.store, threadId, messageId, suggestionId, choice);
      if (step.kind === "missing") return json(res, 404, userError("serverError.taskSuggestion.missing"));
      if (step.kind === "refused") return json(res, 409, { ...userError("serverError.taskSuggestion.changed"), message: step.message });
      return json(res, 200, { ok: true, message: step.message });
    }
    const suggestion = found.card.suggestions[found.index]!;
    if (suggestion.state !== "open") return json(res, 409, { ...userError("serverError.taskSuggestion.changed"), message: found.message });
    starting.add(key);
    try {
      const sent = await deps.send(auth, botId, threadId, suggestion.title);
      const step = answerTaskSuggestion(deps.store, threadId, messageId, suggestionId, "start", sent.message ? { startedMessageId: sent.message.id } : {});
      if (step.kind === "missing") return json(res, 404, userError("serverError.taskSuggestion.missing"));
      const line = sent.message ? deps.store.patchMessage(threadId, sent.message.id, { fromTaskSuggestion: { messageId, suggestionId } }) ?? sent.message : undefined;
      return json(res, 200, { ok: true, message: step.message, ...(line ? { sent: line } : {}) });
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status !== "number") throw error;
      return json(res, status, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      starting.delete(key);
    }
  };
}
