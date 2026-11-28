// The agents catalog's suggest_tasks tool: a bot shows the person a card of tasks it can do now. The internal route
// (server/index.ts) stores the card line at once. A task never starts by itself: the person taps Start, and the server sends
// the title as the person's own message.
import { TASK_SUGGESTION_DESCRIPTION_MAX, TASK_SUGGESTION_ICONS, TASK_SUGGESTION_TITLE_MAX, TASK_SUGGESTIONS_INTRO_MAX, TASK_SUGGESTIONS_MAX } from "../../packages/phone-protocol/src/task-suggestions.ts";
import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const SUGGEST_TASKS_TOOL = "suggest_tasks";

export async function callSuggestTasksTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const r = await context.client.apiResponse("/api/internal/task-suggestions", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, intro: args.intro, tasks: args.tasks }),
  });
  if (!r.ok) return { text: `Couldn't show the tasks: ${String(r.body.error ?? "the request was refused.")}`, isError: true };
  const kept = Number(r.body.kept ?? 0);
  return { text: `Showed ${kept} ${kept === 1 ? "task" : "tasks"}. The person can start or hide each one.` };
}

export const SUGGEST_TASKS_TOOL_DEFINITION = {
  name: SUGGEST_TASKS_TOOL,
  description:
    `Show the person a card of up to ${TASK_SUGGESTIONS_MAX} tasks you can do for them now. Each task has Start and Hide. Start sends the title as the person's own message. Write each title as a short request in the language of this conversation, such as "Draft the weekly follow-up summary". Plain text only: no links, commands or code. Call it at most once in a turn.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      intro: { type: "string", maxLength: TASK_SUGGESTIONS_INTRO_MAX, description: "A short lead-in above the tasks." },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: TASK_SUGGESTIONS_MAX,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", maxLength: TASK_SUGGESTION_TITLE_MAX, description: `The request the person would send, at most ${TASK_SUGGESTION_TITLE_MAX} characters.` },
            description: { type: "string", maxLength: TASK_SUGGESTION_DESCRIPTION_MAX, description: `One line that says what you will do, at most ${TASK_SUGGESTION_DESCRIPTION_MAX} characters.` },
            icon: { type: "string", enum: [...TASK_SUGGESTION_ICONS] },
          },
          required: ["title"],
        },
      },
    },
    required: ["tasks"],
  },
};
