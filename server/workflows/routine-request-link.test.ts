import { describe, expect, it } from "vitest";

import type { RoutineRequestOperation } from "../../shared/routine-request.ts";
import { workflowLinkProblem, type RoutineWorkflowLinks } from "./routine-request-link.ts";

const create = (workflowId: string): RoutineRequestOperation => ({
  action: "create",
  routine: { name: "Daily", instructions: "", schedule: { type: "daily", time: "09:00" }, workflowId },
} as unknown as RoutineRequestOperation);
const routines = { listRoutines: () => [] };
const links = (over: Partial<RoutineWorkflowLinks> & { botIds: string[] }): RoutineWorkflowLinks => ({
  copy: () => ({ workflowId: "wf", prompt: "Steps", botId: "scout", botIds: over.botIds }),
  name: () => "Flow", botName: (id) => id, refusal: () => null, manages: () => true, shown: () => true, ...over,
});

describe("linking a workflow to a routine", () => {
  it("refuses when a later step belongs to a bot the caller may not manage, and leaves the request alone", () => {
    const operation = create("wf");
    const problem = workflowLinkProblem(operation, "scout", routines, links({ botIds: ["scout", "ledger"], manages: (_caller, id) => id !== "ledger" }), "t1");
    expect(problem).toMatchObject({ status: 403 });
    expect(problem?.message).toContain("ledger");
    expect((operation as { routine: { instructions: string } }).routine.instructions).toBe("");
  });

  it("links a workflow whose other bots the caller manages", () => {
    const operation = create("wf");
    expect(workflowLinkProblem(operation, "scout", routines, links({ botIds: ["scout", "peer"] }), "t1")).toBeNull();
    expect((operation as { routine: { instructions: string } }).routine.instructions).toBe("Steps");
  });

  it("answers as if there were no workflow when the person behind the turn cannot see it", () => {
    expect(workflowLinkProblem(create("wf"), "scout", routines, links({ botIds: ["scout"], shown: () => false }), "t1")).toMatchObject({ status: 404 });
  });
});
