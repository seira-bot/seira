import type { VisibleSet } from "../bot-visibility.ts";
import type { Coordinator } from "../coordinator.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import { draftFromThread, plainRequest, windowRoots, withoutMention, type DraftTurnRow } from "../workflows/draft-from-thread.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WorkflowDraftRouteDeps {
  store: Pick<Store, "bot" | "botByThread" | "groupByThread" | "messagesFor" | "activePath">;
  coordinator: Pick<Coordinator, "job">;
  visible(auth: RequestAuth): VisibleSet;
  botsRefusal(auth: RequestAuth, botIds: readonly string[], needed: "chat" | "edit"): string | null;
  workflows(): WorkflowHost | null;
}

const DRAFT_PATH = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/workflow-draft$/;

export function createWorkflowDraftRoutes(deps: WorkflowDraftRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const match = DRAFT_PATH.exec(path);
    if (!match) return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (!deps.workflows()) return json(res, 503, { error: "Workflows are unavailable." });
    const [, threadId, messageId] = match as unknown as [string, string, string];
    const visible = deps.visible(auth);
    const bot = deps.store.botByThread(threadId);
    const group = bot ? undefined : deps.store.groupByThread(threadId);
    if (!visible.thread(threadId) || (!bot && !group)) return json(res, 404, { error: "no such conversation" });

    const reply = deps.store.messagesFor(threadId).find((message) => message.id === messageId);
    if (!reply) return json(res, 404, { error: "no such message" });
    const replyBotId = bot?.id ?? reply.from?.botId;
    if (reply.role !== "bot" || reply.kind !== "text" || reply.turnTerminal !== true || reply.turnSucceeded === false || !replyBotId) {
      return json(res, 409, { error: "This answer isn't finished.", code: "workflow_draw_unfinished" });
    }

    const paths = new Map<string, ReturnType<typeof deps.store.activePath>>();
    const pathOf = (id: string) => {
      let path = paths.get(id);
      if (!path) {
        path = !deps.store.botByThread(id) && !deps.store.groupByThread(id) ? [] : deps.store.activePath(id);
        paths.set(id, path);
      }
      return path;
    };
    const line = pathOf(threadId);
    const upto = line.findIndex((message) => message.id === reply.id);
    const before = (upto >= 0 ? line.slice(0, upto) : line.filter((message) => message.at < reply.at)).reverse();
    const asked = bot && reply.requestMessageId
      ? deps.store.messagesFor(threadId).find((message) => message.id === reply.requestMessageId && message.role === "user")
      : undefined;
    const requestMessage = asked ?? before.find((message) => message.role === "user" && message.kind === "text" && !message.steered && !message.aside && !message.threadPost && (bot || message.text?.trim()));
    if (!requestMessage) return json(res, 409, { error: "This answer has no request to draw.", code: "workflow_draw_no_request" });

    const request = { at: requestMessage.at, text: plainRequest(requestMessage.text ?? "") };
    const { rows } = deps.coordinator.job(threadId, request.at, bot?.id);
    const frame = { threadId, room: !bot, request, reply: { at: reply.at, botId: replyBotId } };
    const roots = windowRoots(rows, frame);
    request.text ||= plainRequest(withoutMention(roots[0]?.brief ?? ""));
    if (!request.text) return json(res, 409, { error: "This answer has no request to draw.", code: "workflow_draw_no_request" });

    const requestBot = roots[0]?.assignee.botId ?? replyBotId;
    if (!deps.store.bot(requestBot) || !visible.bot(requestBot)) return json(res, 404, { error: "no such bot" });
    const short = deps.botsRefusal(auth, [requestBot], "chat");
    if (short) return json(res, 403, { error: short });

    const drawn = draftFromThread({
      ...frame, rows,
      turnRows: (target, from, to, botId) => {
        if (visible.hides(target)) return null;
        return pathOf(target)
          .filter((message) => message.at >= from && message.at <= to && (botId === undefined || message.from?.botId === botId))
          .map((message): DraftTurnRow => ({ at: message.at, role: message.role, kind: message.kind, ...(message.from ? { from: { botId: message.from.botId } } : {}), ...(message.tool ? { tool: { name: message.tool.name, input: message.tool.input, ok: message.tool.ok } } : {}) }));
      },
      threadVisible: (id) => visible.thread(id),
      usable: (botId) => Boolean(deps.store.bot(botId)) && visible.bot(botId) && deps.botsRefusal(auth, [botId], "chat") === null,
    });
    return json(res, 200, drawn);
  };
}
