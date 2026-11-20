import { describe, expect, it } from "vitest";

import { WORKFLOW_LIMITS, type WorkflowConnection, type WorkflowGraph, type WorkflowProblemCode, type WorkflowStep } from "../../shared/workflows";
import { runnableProblem as serverRunnable, validateWorkflowInput } from "../../server/workflows/validate";
import { ApiError } from "@/state/api";
import en from "@/locales/en.json";
import {
  botIdsOf,
  connectRefusal,
  findLoop,
  outgoing,
  PROBLEM_TEXT,
  problemText,
  readingOrder,
  runnableProblem,
  saveProblems,
  serverProblems,
  startSteps,
  stepOrder,
  stepsText,
  stepTitle,
  waitMinutes,
  waitParts,
  waitText,
  type ClientProblem,
} from "./workflow-graph";

const names: Record<string, string> = { ana: "Ana", ben: "Ben" };
const botName = (id: string) => names[id];
const botExists = (id: string) => botName(id) !== undefined;
const at = { x: 1, y: 2 };
const bot = (id: string, botId = "ana", instruction = "Do it"): WorkflowStep => ({ id, kind: "bot", botId, instruction, position: at });
const check = (id: string, question = "Is it ok?"): WorkflowStep => ({ id, kind: "check", question, position: at });
const wait = (id: string, minutes = 5): WorkflowStep => ({ id, kind: "wait", minutes, position: at });
const post = (id: string): WorkflowStep => ({ id, kind: "post", position: at });
const note = (id: string, text = "memo"): WorkflowStep => ({ id, kind: "note", text, position: at });
const link = (id: string, from: string, to: string, branch?: "yes" | "no"): WorkflowConnection => ({ id, from, to, ...(branch ? { branch } : {}) });
const graph = (steps: WorkflowStep[], connections: WorkflowConnection[] = []): WorkflowGraph => ({ steps, connections });
const codes = (problems: ClientProblem[]) => problems.map((problem) => problem.code);

const branching = graph(
  [bot("a"), check("c"), bot("y", "ben"), bot("n"), post("p"), note("z")],
  [link("1", "a", "c"), link("2", "c", "n", "no"), link("3", "c", "y", "yes"), link("4", "y", "p")],
);

describe("workflow graph rules", () => {
  it("finds the start steps, skipping notes and steps with a connection in", () => {
    expect(startSteps(branching).map((step) => step.id)).toEqual(["a"]);
    expect(startSteps(graph([bot("a"), bot("b"), note("n")])).map((step) => step.id)).toEqual(["a", "b"]);
  });

  it("orders steps from the start, Yes before No, each once", () => {
    expect(outgoing(branching, "c").map((connection) => connection.id)).toEqual(["3", "2"]);
    expect(stepOrder(branching).map((step) => step.id)).toEqual(["a", "c", "y", "p", "n"]);
    expect(botIdsOf(branching)).toEqual(["ana", "ben"]);
  });

  it("visits the flow first, then loose steps from top to bottom and left to right", () => {
    const loose = (id: string, x: number, y: number): WorkflowStep => ({ ...note(id), position: { x, y } });
    const body = graph([loose("late", 200, 100), loose("left", 0, 100), loose("top", 100, 0), bot("a")], []);
    expect(readingOrder(body).map((step) => step.id)).toEqual(["a", "top", "left", "late"]);
  });

  it("finds the connection that closes a loop", () => {
    const looped = graph([bot("a"), bot("b"), bot("c")], [link("1", "a", "b"), link("2", "b", "c"), link("3", "c", "a")]);
    expect(findLoop(looped)?.id).toBe("3");
    expect(findLoop(branching)).toBeNull();
  });

  it("reports each save problem with its step", () => {
    const input = {
      name: " ",
      ...graph(
        [bot("a", "gone", " "), check("c", ""), wait("w", 0), note("n")],
        [link("1", "a", "c"), link("2", "c", "w"), link("3", "w", "n"), link("4", "a", "w", "yes")],
      ),
    };
    expect(saveProblems(input, botExists)).toEqual([
      { code: "workflow_name" },
      { code: "workflow_bot_missing", stepId: "a" },
      { code: "workflow_instruction_missing", stepId: "a" },
      { code: "workflow_question_missing", stepId: "c" },
      { code: "workflow_wait_range", stepId: "w" },
      { code: "workflow_note_connected", stepId: "n", connectionId: "3" },
      { code: "workflow_branch_not_check", stepId: "a", connectionId: "4" },
      { code: "workflow_branch_missing", stepId: "c", connectionId: "2" },
      { code: "workflow_too_many_outgoing", stepId: "a" },
    ]);
    expect(saveProblems({ name: "x".repeat(81), ...graph([bot("a")]) }, botExists)).toEqual([{ code: "workflow_name" }]);
    const big = graph(Array.from({ length: WORKFLOW_LIMITS.steps + 1 }, (_, index) => bot(`s${index}`)));
    expect(codes(saveProblems({ name: "Big", ...big }, botExists))).toEqual(["workflow_too_big"]);
  });

  describe("agrees with the server", () => {
    const fixtures: Array<[string, string, WorkflowGraph]> = [
      ["valid branching", "Morning", branching],
      ["empty", "Empty", graph([])],
      ["no name", "  ", graph([bot("a")])],
      ["long name", "x".repeat(81), graph([bot("a")])],
      ["only a note", "Notes", graph([note("n")])],
      ["two starts", "Two", graph([bot("a"), bot("b", "ben")])],
      ["start is a wait", "Wait", graph([wait("w"), bot("a")], [link("1", "w", "a")])],
      ["missing bot", "Gone", graph([bot("a", "gone")])],
      ["blank instruction and question", "Blank", graph([bot("a", "ana", "  "), check("c", " ")], [link("1", "a", "c")])],
      ["wait too long", "Long", graph([bot("a"), wait("w", WORKFLOW_LIMITS.waitMinutes + 1)], [link("1", "a", "w")])],
      ["wait not whole", "Odd", graph([bot("a"), wait("w", 1.5)], [link("1", "a", "w")])],
      ["text too long", "Text", graph([bot("a", "ana", "x".repeat(WORKFLOW_LIMITS.instruction + 1)), note("n", "x".repeat(WORKFLOW_LIMITS.note + 1))])],
      ["duplicate step id", "Dup", graph([bot("a"), bot("a")])],
      ["duplicate connection id", "Dup", graph([bot("a"), bot("b"), bot("c")], [link("1", "a", "b"), link("1", "b", "c")])],
      ["unknown step", "Unknown", graph([bot("a")], [link("1", "a", "zz")])],
      ["note connected", "Note", graph([bot("a"), note("n")], [link("1", "a", "n")])],
      ["branch on a bot step", "Branch", graph([bot("a"), bot("b")], [link("1", "a", "b", "yes")])],
      ["check without a branch", "Branch", graph([check("c"), bot("b")], [link("1", "c", "b")])],
      ["two Yes branches", "Yes", graph([bot("a"), check("c"), bot("b"), bot("d")], [link("1", "a", "c"), link("2", "c", "b", "yes"), link("3", "c", "d", "yes")])],
      ["two next steps", "Next", graph([bot("a"), bot("b"), bot("c")], [link("1", "a", "b"), link("2", "a", "c")])],
      ["loop", "Loop", graph([bot("a"), bot("b")], [link("1", "a", "b"), link("2", "b", "a")])],
      ["too many steps", "Big", graph(Array.from({ length: WORKFLOW_LIMITS.steps + 1 }, (_, index) => bot(`s${index}`)))],
    ];

    it.each(fixtures)("on save: %s", (_label, name, body) => {
      const result = validateWorkflowInput({ name, ...body }, { botName });
      const server = result.ok ? [] : result.problems.map(({ code, stepId, connectionId }) => ({ code, stepId, connectionId }));
      const client = saveProblems({ name, ...body }, botExists).map(({ code, stepId, connectionId }) => ({ code, stepId, connectionId }));
      expect(client).toEqual(server);
    });

    it.each(fixtures)("on run: %s", (_label, _name, body) => {
      const server = serverRunnable(body, { botName });
      const client = runnableProblem(body, botExists);
      expect(client?.code).toBe(server?.code);
      expect(client?.stepId).toBe(server?.stepId);
    });
  });

  it("reports a run problem: no start, two starts, a start that is not a bot step, a missing bot", () => {
    expect(runnableProblem(graph([note("n")]), botExists)).toEqual({ code: "workflow_no_start" });
    expect(runnableProblem(graph([bot("a"), bot("b")]), botExists)).toEqual({ code: "workflow_many_starts", stepId: "b" });
    expect(runnableProblem(graph([wait("w")]), botExists)).toEqual({ code: "workflow_start_not_bot", stepId: "w" });
    expect(runnableProblem(graph([bot("a"), bot("b", "gone")], [link("1", "a", "b")]), botExists)).toEqual({ code: "workflow_bot_missing", stepId: "b" });
    expect(runnableProblem(branching, botExists)).toBeNull();
  });

  it("refuses a connection to itself, to or from a note, and one that makes a loop", () => {
    const line = graph([bot("a"), bot("b"), bot("c"), note("n"), check("k")], [link("1", "a", "b"), link("2", "b", "c")]);
    expect(connectRefusal(line, "a", "a")).toBe("self");
    expect(connectRefusal(line, "a", "n")).toBe("note");
    expect(connectRefusal(line, "n", "a")).toBe("note");
    expect(connectRefusal(line, "c", "a")).toBe("loop");
    expect(connectRefusal(line, "a", "c")).toBeNull();
    expect(connectRefusal(line, "c", "b")).toBe("loop");
    const withCheck = graph([bot("a"), check("k"), bot("b")], [link("1", "a", "k"), link("2", "k", "b", "yes")]);
    expect(connectRefusal(withCheck, "k", "a", "no")).toBe("loop");
    expect(connectRefusal(withCheck, "k", "b", "no")).toBeNull();
  });

  it("gives every problem code an English text with its values filled", () => {
    const body = graph([bot("a"), check("c"), wait("w"), note("n"), post("p")]);
    for (const code of Object.keys(PROBLEM_TEXT) as WorkflowProblemCode[]) {
      for (const stepId of [undefined, "a", "c", "w", "n", "p"]) {
        const text = problemText({ code, stepId }, body, botName);
        expect(text, `${code} ${stepId}`).not.toMatch(/\{\w+\}/);
        expect(text).not.toContain("undefined");
      }
    }
    expect(problemText({ code: "workflow_bot_missing", stepId: "a" }, body, botName)).toBe("Ana: choose a bot for this step.");
    expect(problemText({ code: "workflow_loop", stepId: "w" }, body, botName)).toBe("Wait: this connection makes a loop. Remove it.");
    expect(problemText({ code: "workflow_name" }, body, botName)).toBe(`Use a name of ${WORKFLOW_LIMITS.name} characters or fewer.`);
    expect(problemText({ code: "workflow_name" }, { ...body, name: "x".repeat(81) }, botName)).toBe(`Use a name of ${WORKFLOW_LIMITS.name} characters or fewer.`);
    expect(problemText({ code: "workflow_name" }, { ...body, name: "  " }, botName)).toBe("Give the workflow a name.");
    expect(problemText({ code: "workflow_too_big" }, body, botName)).toBe("A workflow can have 50 steps and 100 connections at most.");
    for (const key of Object.values(PROBLEM_TEXT)) expect(Object.hasOwn(en, key)).toBe(true);
  });

  it("maps a server error body to problems on their steps", () => {
    const body = { error: "x", code: "workflow_bot_missing", stepId: "a", problems: [
      { code: "workflow_bot_missing", stepId: "a", message: "m" },
      { code: "workflow_loop", stepId: "b", connectionId: "2", message: "m" },
      { code: "not_a_code", message: "m" },
    ] };
    expect(serverProblems(new ApiError("x", 400, body))).toEqual([
      { code: "workflow_bot_missing", stepId: "a" },
      { code: "workflow_loop", stepId: "b", connectionId: "2" },
    ]);
    expect(serverProblems(new ApiError("x", 400, { error: "x", code: "workflow_no_start" }))).toEqual([{ code: "workflow_no_start" }]);
    expect(serverProblems(new ApiError("x", 400, { error: "x", code: "other" }))).toEqual([]);
    expect(serverProblems(new ApiError("x", 400))).toEqual([]);
    expect(serverProblems(new TypeError("offline"))).toEqual([]);
  });

  it("splits wait minutes into the largest whole unit and back", () => {
    expect(waitParts(90)).toEqual({ amount: 90, unit: "minutes" });
    expect(waitParts(120)).toEqual({ amount: 2, unit: "hours" });
    expect(waitParts(2880)).toEqual({ amount: 2, unit: "days" });
    expect(waitParts(1440)).toEqual({ amount: 1, unit: "days" });
    expect(waitMinutes(2, "days")).toBe(2880);
    expect(waitMinutes(3, "hours")).toBe(180);
    expect(waitMinutes(7, "minutes")).toBe(7);
    expect(waitText(90)).toBe("90 minutes");
    expect(waitText(1)).toBe("1 minute");
    expect(waitText(120)).toBe("2 hours");
    expect(waitText(1440)).toBe("1 day");
    expect(stepsText(1)).toBe("1 step");
    expect(stepsText(3)).toBe("3 steps");
  });

  it("titles each step kind for a person", () => {
    expect(stepTitle(bot("a"), botName)).toBe("Ana");
    expect(stepTitle(bot("a", "gone"), botName)).toBe("No bot chosen");
    expect(stepTitle(check("c", "Is it ok?"), botName)).toBe("Is it ok?");
    expect(stepTitle(check("c", ""), botName)).toBe("Write a yes-or-no question");
    expect(stepTitle(check("c", "q".repeat(70)), botName)).toBe(`${"q".repeat(60)}…`);
    expect(stepTitle(wait("w", 120), botName)).toBe("For 2 hours");
    expect(stepTitle(post("p"), botName)).toBe("Where the routine posts results");
    expect(stepTitle(note("n", "\n first line \nsecond"), botName)).toBe("first line");
    expect(stepTitle(note("n", ""), botName)).toBe("Empty note");
  });
});
