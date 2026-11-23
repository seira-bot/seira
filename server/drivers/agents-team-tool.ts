// The Chief's suggest_team tool and its internal route. It shows a card in the chat and creates nothing.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set(["suggest_team"]);

export const TEAM_TOOL_DEFINITIONS = [
  {
    name: "suggest_team",
    description: "Chief only: show a suggested team for the person's work as a card. Creates nothing; they edit, create or skip it. Call once, then end the turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        department: { type: "string" },
        summary: { type: "string" },
        bots: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: { name: { type: "string" }, role: { type: "string" }, job: { type: "string" }, instructions: { type: "string" } },
            required: ["name", "role", "job"],
          },
        },
        group_chats: {
          type: "array",
          items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, members: { type: "array", items: { type: "string" } } }, required: ["name", "members"] },
        },
        first_task: { type: "string" },
      },
      required: ["department", "bots"],
    },
  },
];

export async function callTeamTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/team-suggestion", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "Done.") } : { text: String(body.error ?? "The suggestion could not be shown. Try again shortly."), isError: true };
}
