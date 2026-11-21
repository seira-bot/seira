import { describe, expect, it } from "vitest";

import { agentWorkflows, sequentialWorkflow } from "./agent-tools.ts";
import type { Workflow } from "../../shared/workflows.ts";

const position = { x: 0, y: 0 };
const flow: Workflow = {
  id: "wf1", name: "Round", createdAt: 1, updatedAt: 1,
  steps: [
    { id: "a", kind: "bot", botId: "scout", instruction: "Collect", position },
    { id: "b", kind: "bot", botId: "ledger", instruction: "Secret plan", position },
  ],
  connections: [{ id: "c", from: "a", to: "b" }],
};

describe("agentWorkflows", () => {
  const facts = { botId: "scout", botName: (id: string) => ({ scout: "Scout", ledger: "Ledger" })[id], routines: [{ id: "r1", name: "Daily", botId: "scout", workflowId: "wf1" }, { id: "r2", name: "Other", botId: "ledger", workflowId: "wf1" }] };

  it("shows only the caller's own instructions and the routines of that bot", () => {
    const [one] = agentWorkflows([flow], facts);
    expect(one).toMatchObject({ id: "wf1", stepCount: 2, routines: [{ id: "r1", name: "Daily" }] });
    expect(JSON.stringify(one)).not.toContain("Secret plan");
    expect(one!.steps[0]).toMatchObject({ yours: true, instruction: "Collect" });
  });

  it("leaves out a workflow without a step of the caller", () => {
    expect(agentWorkflows([flow], { ...facts, botId: "other" })).toEqual([]);
  });
});

describe("sequentialWorkflow", () => {
  it("joins the steps one after the other, and a check passes only yes", () => {
    let n = 0;
    const built = sequentialWorkflow({ name: "Q", steps: [{ kind: "bot", instruction: "A" }, { kind: "check", question: "Ok?" }, { kind: "post" }] }, "scout", (prefix) => `${prefix}${++n}`);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input.steps).toHaveLength(3);
      expect(built.input.connections.map((c) => [c.from, c.to, c.branch])).toEqual([["s1", "s2", undefined], ["s2", "s3", "yes"]]);
    }
  });

  it("refuses a step without what it needs", () => {
    expect(sequentialWorkflow({ name: "Q", steps: [{ kind: "bot" }] }, "scout")).toMatchObject({ ok: false });
    expect(sequentialWorkflow({ name: "", steps: [{ kind: "post" }] }, "scout")).toMatchObject({ ok: false });
  });
});
