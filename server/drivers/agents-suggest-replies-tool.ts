// The agents catalog's suggest_replies tool: a bot offers short follow-up chips for the reply it is writing. The internal
// route (server/routes/internal-threads.ts) cleans the list and holds it; the server puts it on the turn's last text line
// only if the turn ends well. A chip never sends anything: the person taps it and sends it.
import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const SUGGEST_REPLIES_TOOL = "suggest_replies";

export async function callSuggestRepliesTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const r = await context.client.api("/api/internal/suggested-replies", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, replies: args.replies }),
  });
  if (r.error) return { text: `Couldn't keep the replies: ${String(r.error)}`, isError: true };
  const kept = Number(r.kept ?? 0);
  return { text: kept > 0 ? `Kept ${kept} suggested ${kept === 1 ? "reply" : "replies"}. They show only if this turn ends well.` : "No reply was kept: each needs a plain-text title and prompt within the limits, with no link, command or code." };
}

export const SUGGEST_REPLIES_TOOL_DEFINITION = {
  name: SUGGEST_REPLIES_TOOL,
  description:
    "Offer up to 4 short follow-up replies the person could tap after your answer, only when they would truly help. Call it once, in the turn that writes the answer. A tap fills the person's composer and they decide to send, so write each prompt as the person would say it, in the language of this conversation. Plain text only: no links, commands or code. Leave it out when there is no clear next step.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      replies: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "The chip label, at most 40 characters." },
            prompt: { type: "string", description: "The text the person would send, at most 500 characters." },
          },
          required: ["title", "prompt"],
        },
      },
    },
    required: ["replies"],
  },
};
