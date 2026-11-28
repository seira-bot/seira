import { describe, expect, it, vi } from "vitest";

import { TASK_SUGGESTION_ICONS } from "../../packages/phone-protocol/src/task-suggestions.ts";
import { isReadOnlyAgentTool } from "../agent-tool-policy.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools } from "./agents-catalog.ts";
import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { callSuggestTasksTool, SUGGEST_TASKS_TOOL, SUGGEST_TASKS_TOOL_DEFINITION } from "./agents-suggest-tasks-tool.ts";

const context = (answer: { ok: boolean; status?: number; body: Record<string, unknown> }) =>
  ({ botId: "bot-1", threadId: "t-1", client: { apiResponse: vi.fn(async () => ({ status: answer.ok ? 201 : 400, ...answer })) } }) as unknown as ToolCallContext;

describe("the suggest_tasks tool", () => {
  it("is listed to a bot and writes to the chat", () => {
    expect(availableTools(catalogProfileFromEnv({ SEIRA_BOT_ID: "bot" })).map((tool) => tool.name)).toContain(SUGGEST_TASKS_TOOL);
    expect(isReadOnlyAgentTool(SUGGEST_TASKS_TOOL)).toBe(false);
  });

  it("takes 1 to 5 tasks with a title of at most 80 characters, a description and a known icon", () => {
    const { inputSchema } = SUGGEST_TASKS_TOOL_DEFINITION;
    expect(inputSchema.properties.intro.maxLength).toBe(200);
    expect(inputSchema.properties.tasks).toMatchObject({ minItems: 1, maxItems: 5 });
    const item = inputSchema.properties.tasks.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["title"]);
    expect(item.properties.title.maxLength).toBe(80);
    expect(item.properties.description.maxLength).toBe(240);
    expect(item.properties.icon.enum).toEqual([...TASK_SUGGESTION_ICONS]);
  });

  it("posts the sender, the intro and the tasks to the route and counts what was kept", async () => {
    const asked = context({ ok: true, body: { ok: true, messageId: "m1", kept: 2 } });
    const tasks = [{ title: "A" }, { title: "B" }];
    await expect(callTool(SUGGEST_TASKS_TOOL, { intro: "Hi", tasks }, asked)).resolves.toEqual({ text: "Showed 2 tasks. The person can start or hide each one." });
    const [path, init] = (asked.client.apiResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(path).toBe("/api/internal/task-suggestions");
    expect(JSON.parse(init.body)).toEqual({ fromBotId: "bot-1", fromThreadId: "t-1", intro: "Hi", tasks });
    await expect(callSuggestTasksTool({ tasks }, context({ ok: true, body: { kept: 1 } }))).resolves.toEqual({ text: "Showed 1 task. The person can start or hide each one." });
  });

  it("hands back the error text when the route refuses, such as when no task is kept", async () => {
    await expect(callSuggestTasksTool({ tasks: [] }, context({ ok: false, body: { error: "No task was kept: each needs a plain-text title." } })))
      .resolves.toEqual({ text: "Couldn't show the tasks: No task was kept: each needs a plain-text title.", isError: true });
  });
});
