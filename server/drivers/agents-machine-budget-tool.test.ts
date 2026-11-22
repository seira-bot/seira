import { describe, expect, it, vi } from "vitest";

import { isReadOnlyAgentTool } from "../agent-tool-policy.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools } from "./agents-catalog.ts";
import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { callMachineBudgetTool, MACHINE_BUDGET_TOOL } from "./agents-usage-tool.ts";

const context = (answer: { ok: boolean; body: Record<string, unknown> }) => ({ client: { apiResponse: vi.fn(async () => answer) } }) as unknown as ToolCallContext;

describe("the machine_budget tool", () => {
  it("is read-only and listed to every bot", () => {
    expect(isReadOnlyAgentTool(MACHINE_BUDGET_TOOL)).toBe(true);
    for (const env of [{}, { SEIRA_CHIEF_OF_STAFF: "1" }, { SEIRA_ROOM_TURN: "1" }]) {
      const tools = availableTools(catalogProfileFromEnv({ SEIRA_BOT_ID: "bot", ...env })).map((tool) => tool.name);
      expect(tools).toContain(MACHINE_BUDGET_TOOL);
    }
  });
  it("reaches the route by name and hands back its answer or its error", async () => {
    const asked = context({ ok: true, body: { text: '{"suggestedWorkers":2}' } });
    await expect(callTool(MACHINE_BUDGET_TOOL, {}, asked)).resolves.toEqual({ text: '{"suggestedWorkers":2}' });
    expect(asked.client.apiResponse).toHaveBeenCalledWith("/api/internal/machine-budget");
    await expect(callMachineBudgetTool(context({ ok: false, body: { error: "no" } }))).resolves.toEqual({ text: "no", isError: true });
  });
});
