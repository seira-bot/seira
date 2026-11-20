import { describe, expect, it } from "vitest";

import type { WorkflowGraph, WorkflowProblem, WorkflowProblemCode } from "../../shared/workflows.ts";
import { problemBody, runnableProblem, validateWorkflowInput } from "./validate.ts";

const facts = { botName: (id: string) => ({ ana: "Ana", ben: "Ben" } as Record<string, string>)[id] };
const at = { x: 1, y: 2 };
const bot = (id: string, botId = "ana", instruction = "Do it") => ({ id, kind: "bot", botId, instruction, position: at });
const check = (id: string, question = "Is it ok?") => ({ id, kind: "check", question, position: at });
const wait = (id: string, minutes: unknown = 5) => ({ id, kind: "wait", minutes, position: at });
const post = (id: string) => ({ id, kind: "post", position: at });
const note = (id: string, text = "memo") => ({ id, kind: "note", text, position: at });
const link = (id: string, from: string, to: string, branch?: string) => ({ id, from, to, ...(branch ? { branch } : {}) });
const input = (steps: unknown[], connections: unknown[] = [], name = "Morning") => ({ name, steps, connections });

const problems = (body: unknown): WorkflowProblem[] => {
  const result = validateWorkflowInput(body, facts);
  if (result.ok) throw new Error("expected a refusal");
  return result.problems;
};
const codes = (body: unknown): WorkflowProblemCode[] => problems(body).map((p) => p.code);
const first = (body: unknown): WorkflowProblem => problems(body)[0]!;

describe("saving a workflow", () => {
  it("accepts a valid workflow and trims the name", () => {
    const result = validateWorkflowInput(
      input([bot("a"), check("c"), post("p"), wait("w", 43_200), note("n")], [link("1", "a", "c"), link("2", "c", "p", "yes"), link("3", "c", "w", "no")], "  Morning  "),
      facts,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Morning");
      expect(result.value.steps).toHaveLength(5);
    }
  });

  it("keeps ifUpdatedAt and drops fields it does not know", () => {
    const result = validateWorkflowInput({ ...input([bot("a")]), ifUpdatedAt: 7, extra: 1 }, facts);
    expect(result.ok && result.value).toEqual({ name: "Morning", steps: [bot("a")], connections: [], ifUpdatedAt: 7 });
  });

  it("keeps a field of a newer version on a step and on a connection", () => {
    const result = validateWorkflowInput(input([{ ...bot("a"), color: "red" }, { ...post("p"), retries: 2 }], [{ ...link("1", "a", "p"), label: "then" }]), facts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps[0]).toMatchObject({ color: "red" });
      expect(result.value.steps[1]).toMatchObject({ retries: 2 });
      expect(result.value.connections[0]).toMatchObject({ label: "then" });
    }
  });

  it("refuses a body that has the wrong shape (code 1)", () => {
    for (const body of [null, "x", {}, { name: "A", steps: "no", connections: [] }, input([{ id: "a", kind: "robot", position: at }]), input([bot("bad id!")]), input([{ ...wait("w"), minutes: "5" }])]) {
      expect(first(body)).toEqual({ code: "workflow_shape", message: "This workflow could not be saved. Reload it and try again." });
    }
  });

  it("refuses an empty name (code 2)", () => {
    expect(first(input([bot("a")], [], "   "))).toEqual({ code: "workflow_name", message: "Give the workflow a name." });
    expect(codes(input([bot("a")], [], "x".repeat(81)))).toEqual(["workflow_name"]);
  });

  it("refuses more than 50 steps or 100 connections (code 3)", () => {
    const steps = Array.from({ length: 51 }, (_, i) => bot(`s${i}`));
    expect(first(input(steps)).code).toBe("workflow_too_big");
    const links = Array.from({ length: 101 }, (_, i) => link(`k${i}`, "s0", "s1"));
    expect(first(input([bot("s0"), bot("s1")], links)).code).toBe("workflow_too_big");
    expect(validateWorkflowInput(input(Array.from({ length: 50 }, (_, i) => bot(`s${i}`))), facts).ok).toBe(true);
  });

  it("refuses two steps or two connections with the same id (code 4)", () => {
    expect(problems(input([bot("a"), bot("a")]))[0]).toMatchObject({ code: "workflow_duplicate_id", stepId: "a" });
    expect(problems(input([bot("a"), bot("b")], [link("k", "a", "b"), link("k", "a", "b")]))[0]).toMatchObject({ code: "workflow_duplicate_id", connectionId: "k" });
  });

  it("rejects a bot step without a bot or an instruction (codes 5 and 6)", () => {
    expect(problems(input([bot("a", "")]))[0]).toEqual({ code: "workflow_bot_missing", stepId: "a", message: "Bot step: choose a bot for this step." });
    expect(problems(input([bot("a", "gone")]))[0]?.code).toBe("workflow_bot_missing");
    expect(problems(input([bot("a", "ana", "  ")]))[0]).toEqual({ code: "workflow_instruction_missing", stepId: "a", message: "Ana: tell the bot what to do in this step." });
    expect(codes(input([bot("a", "", "")]))).toEqual(["workflow_bot_missing", "workflow_instruction_missing"]);
  });

  it("refuses an AI check without a question (code 7)", () => {
    expect(problems(input([bot("a"), check("c", " ")], [link("1", "a", "c")]))[0]).toEqual({ code: "workflow_question_missing", stepId: "c", message: "AI check: write the yes-or-no question." });
  });

  it("refuses a wait outside 1 minute to 30 days (code 8)", () => {
    for (const minutes of [0, -1, 1.5, 43_201]) {
      expect(problems(input([wait("w", minutes)]))[0]).toEqual({ code: "workflow_wait_range", stepId: "w", message: "Wait: choose 1 minute to 30 days." });
    }
    expect(validateWorkflowInput(input([wait("w", 1)]), facts).ok).toBe(true);
  });

  it("refuses a text that is too long (code 9)", () => {
    expect(first(input([bot("a", "ana", "x".repeat(20_001))])).code).toBe("workflow_text_too_long");
    expect(first(input([check("c", "x".repeat(2_001))])).code).toBe("workflow_text_too_long");
    expect(first(input([note("n", "x".repeat(2_001))])).code).toBe("workflow_text_too_long");
    expect(validateWorkflowInput(input([bot("a", "ana", "x".repeat(20_000)), note("n", "x".repeat(2_000))]), facts).ok).toBe(true);
  });

  it("refuses a connection to a step that does not exist (code 10)", () => {
    expect(problems(input([bot("a")], [link("k", "a", "missing")]))[0]).toMatchObject({ code: "workflow_unknown_step", connectionId: "k" });
    expect(first(input([bot("a")], [link("k", "missing", "a")])).code).toBe("workflow_unknown_step");
  });

  it("rejects a connection to or from a note (code 11)", () => {
    const to = problems(input([bot("a"), note("n")], [link("k", "a", "n")]))[0];
    expect(to).toEqual({ code: "workflow_note_connected", stepId: "n", connectionId: "k", message: "Note: a note can't connect to steps." });
    expect(first(input([bot("a"), note("n")], [link("k", "n", "a")])).code).toBe("workflow_note_connected");
  });

  it("rejects Yes or No from a step that is not an AI check (code 12)", () => {
    expect(problems(input([bot("a"), post("p")], [link("k", "a", "p", "yes")]))[0]).toEqual({
      code: "workflow_branch_not_check", stepId: "a", connectionId: "k", message: "Ana: only an AI check has Yes and No connections.",
    });
  });

  it("refuses a connection out of an AI check that is not marked (code 13)", () => {
    expect(problems(input([check("c"), post("p")], [link("k", "c", "p")]))[0]).toEqual({
      code: "workflow_branch_missing", stepId: "c", connectionId: "k", message: "AI check: mark this connection Yes or No.",
    });
  });

  it("refuses a second Yes or a second No (code 14)", () => {
    const steps = [check("c"), post("p"), post("q")];
    expect(problems(input(steps, [link("1", "c", "p", "yes"), link("2", "c", "q", "yes")]))[0]).toEqual({
      code: "workflow_duplicate_branch", stepId: "c", connectionId: "2", message: "AI check: it already has a Yes connection.",
    });
    expect(first(input(steps, [link("1", "c", "p", "no"), link("2", "c", "q", "no")])).message).toBe("AI check: it already has a No connection.");
  });

  it("refuses a step that connects to two next steps (code 15)", () => {
    expect(problems(input([bot("a"), post("p"), post("q")], [link("1", "a", "p"), link("2", "a", "q")]))[0]).toEqual({
      code: "workflow_too_many_outgoing", stepId: "a", message: "Ana: a step connects to one next step only.",
    });
  });

  it("rejects a loop and names the step (code 16)", () => {
    const loop = problems(input([bot("a"), bot("b", "ben")], [link("1", "a", "b"), link("2", "b", "a")]));
    expect(loop).toEqual([{ code: "workflow_loop", stepId: "b", connectionId: "2", message: "Ben: this connection makes a loop. Remove it." }]);
    expect(first(input([bot("a")], [link("1", "a", "a")]))).toMatchObject({ code: "workflow_loop", stepId: "a" });
    const viaCheck = input([bot("a"), check("c")], [link("1", "a", "c"), link("2", "c", "a", "no")]);
    expect(first(viaCheck).code).toBe("workflow_loop");
  });

  it("lists every problem, in the order of the rules", () => {
    expect(codes(input([bot("a", "", ""), check("c", ""), wait("w", 0)], [link("k", "a", "gone")], ""))).toEqual([
      "workflow_name", "workflow_bot_missing", "workflow_instruction_missing", "workflow_question_missing", "workflow_wait_range", "workflow_unknown_step",
    ]);
  });

  it("accepts a draft that cannot run yet", () => {
    expect(validateWorkflowInput(input([]), facts).ok).toBe(true);
    expect(validateWorkflowInput(input([post("p")]), facts).ok).toBe(true);
  });
});

describe("running a saved workflow", () => {
  const graph = (steps: unknown[], connections: unknown[] = []) => ({ steps, connections }) as WorkflowGraph;

  it("refuses a workflow with nothing but notes", () => {
    expect(runnableProblem(graph([]), facts)).toEqual({ code: "workflow_no_start", message: "Add a bot step to start this workflow." });
    expect(runnableProblem(graph([note("n")]), facts)?.code).toBe("workflow_no_start");
  });

  it("refuses more than one first step", () => {
    expect(runnableProblem(graph([bot("a"), bot("b")]), facts)).toMatchObject({
      code: "workflow_many_starts", stepId: "b", message: "A workflow starts at one step. Connect the other first steps after it.",
    });
  });

  it("refuses a first step that is not a bot step", () => {
    expect(runnableProblem(graph([wait("w"), bot("a")], [link("1", "w", "a")]), facts)).toEqual({
      code: "workflow_start_not_bot", stepId: "w", message: "A workflow starts with a bot step.",
    });
  });

  it("refuses a bot that was deleted", () => {
    const steps = [bot("a"), bot("b", "gone")];
    expect(runnableProblem(graph(steps, [link("1", "a", "b")]), facts)).toEqual({
      code: "workflow_bot_missing", stepId: "b", message: "Bot step: choose a bot for this step.",
    });
  });

  it("passes a workflow that can run, notes aside", () => {
    expect(runnableProblem(graph([bot("a"), check("c"), post("p"), note("n")], [link("1", "a", "c"), link("2", "c", "p", "yes")]), facts)).toBeNull();
  });
});

describe("the refusal body", () => {
  it("carries the first problem and at most 20 problems", () => {
    const many: WorkflowProblem[] = Array.from({ length: 25 }, (_, i) => ({ code: "workflow_loop", stepId: `s${i}`, connectionId: `k${i}`, message: `m${i}` }));
    const body = problemBody(many);
    expect(body).toMatchObject({ error: "m0", code: "workflow_loop", stepId: "s0", connectionId: "k0" });
    expect(body.problems).toHaveLength(20);
  });

  it("leaves out the step and connection when the problem has none", () => {
    expect(problemBody([{ code: "workflow_name", message: "Give the workflow a name." }])).toEqual({
      error: "Give the workflow a name.", code: "workflow_name", problems: [{ code: "workflow_name", message: "Give the workflow a name." }],
    });
  });
});
