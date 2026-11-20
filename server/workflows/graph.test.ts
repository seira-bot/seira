import { describe, expect, it } from "vitest";

import type { WorkflowConnection, WorkflowGraph, WorkflowStep } from "../../shared/workflows.ts";
import { botIdsOf, findLoop, outgoing, reachable, startSteps, stepLabel, stepOrder } from "./graph.ts";

const at = { x: 0, y: 0 };
const bot = (id: string, botId = "b1"): WorkflowStep => ({ id, kind: "bot", botId, instruction: "Do it", position: at });
const check = (id: string): WorkflowStep => ({ id, kind: "check", question: "Ok?", position: at });
const note = (id: string): WorkflowStep => ({ id, kind: "note", text: "n", position: at });
const link = (id: string, from: string, to: string, branch?: "yes" | "no"): WorkflowConnection => ({ id, from, to, ...(branch ? { branch } : {}) });
const graph = (steps: WorkflowStep[], connections: WorkflowConnection[]): WorkflowGraph => ({ steps, connections });

describe("workflow graph helpers", () => {
  const branching = graph(
    [bot("a"), check("c"), bot("y", "b2"), bot("n", "b1"), { id: "p", kind: "post", position: at }, note("z")],
    [link("1", "a", "c"), link("2", "c", "n", "no"), link("3", "c", "y", "yes"), link("4", "y", "p")],
  );

  it("finds the start steps and ignores notes", () => {
    expect(startSteps(branching).map((s) => s.id)).toEqual(["a"]);
  });

  it("puts Yes before No and lists each step once", () => {
    expect(outgoing(branching, "c").map((c) => c.id)).toEqual(["3", "2"]);
    expect(stepOrder(branching).map((s) => s.id)).toEqual(["a", "c", "y", "p", "n"]);
  });

  it("lists the bots once, in step order", () => {
    expect(botIdsOf(branching)).toEqual(["b1", "b2"]);
  });

  it("returns what a step reaches, itself included", () => {
    expect([...reachable(branching, "y")].sort()).toEqual(["p", "y"]);
    expect(reachable(branching, undefined).size).toBe(0);
  });

  it("names the connection that closes a loop, a self loop included", () => {
    expect(findLoop(branching)).toBeNull();
    expect(findLoop(graph([bot("a"), bot("b")], [link("1", "a", "b"), link("2", "b", "a")]))?.id).toBe("2");
    expect(findLoop(graph([bot("a")], [link("1", "a", "a")]))?.id).toBe("1");
  });

  it("labels each kind", () => {
    const name = (id: string) => (id === "b1" ? "Ana" : undefined);
    expect(stepLabel(bot("a"), name)).toBe("Ana");
    expect(stepLabel(bot("a", "gone"), name)).toBe("Bot step");
    expect(stepLabel(check("c"), name)).toBe("AI check");
    expect(stepLabel({ id: "w", kind: "wait", minutes: 5, position: at }, name)).toBe("Wait");
    expect(stepLabel({ id: "p", kind: "post", position: at }, name)).toBe("Post results");
    expect(stepLabel(note("z"), name)).toBe("Note");
  });
});
