import type { Bot } from "@/state/store";
import { api } from "@/state/api";
import { createBotThrough } from "../../shared/new-bot-request";

/** `POST /api/bots` for a bot of the person's own, sent again with the same retry key when no answer came (shared/new-bot-request.ts). */
export function postNewBot(body: object, request: typeof api = api): Promise<{ bot: Bot; paused?: true }> {
  return createBotThrough(body, (path, init) => request<{ bot: Bot; paused?: true }>(path, init));
}
