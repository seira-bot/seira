import { describe, expect, it } from "vitest";

import { callTool, type ToolCallContext } from "./agents-call.ts";
import { WORKFLOW_TOOL_DEFINITION } from "./agents-workflow-tool.ts";

function context(response: { ok: boolean; status: number; body: Record<string, unknown> }) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = { apiResponse: async (path: string, init: RequestInit) => { calls.push({ path, body: JSON.parse(String(init.body)) }); return response; } };
  return { calls, ctx: { botId: "scout", threadId: "thread-1", externalRuntime: false, sharedComputers: false, client } as unknown as ToolCallContext };
}

describe("the workflow tool", () => {
  it("declares create with a name and ordered steps", () => {
    expect(WORKFLOW_TOOL_DEFINITION.inputSchema.required).toEqual(["action", "name", "steps"]);
    expect(WORKFLOW_TOOL_DEFINITION.inputSchema.properties.action.enum).toEqual(["create"]);
  });

  it("sends the steps and says where the person finds the workflow", async () => {
    const { calls, ctx } = context({ ok: true, status: 201, body: { workflow: { id: "wf9", name: "Daily", steps: 2 } } });
    const steps = [{ kind: "bot", instruction: "Collect" }, { kind: "post" }];
    const result = await callTool("workflow", { action: "create", name: "Daily", steps }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("wf9");
    expect(result.text).toContain("The person finds it under Automations → Workflows.");
    expect(calls[0]).toEqual({ path: "/api/internal/workflows", body: { fromBotId: "scout", fromThreadId: "thread-1", name: "Daily", steps } });
  });

  it("returns the problem and claims nothing when the workflow is refused", async () => {
    const { ctx } = context({ ok: false, status: 400, body: { error: "Step 1 needs an instruction." } });
    const result = await callTool("workflow", { action: "create", name: "Daily", steps: [{ kind: "bot" }] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("The workflow was not saved: Step 1 needs an instruction.");
  });
});
