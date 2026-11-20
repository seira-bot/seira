import { describe, expect, it } from "vitest";

import type { WorkflowStep } from "../../shared/workflows";
import {
  draftReducer, edgeMid, edgePath, fitSteps, freeSpot, inPoint, newStep, portPoint, removalOf, snap, STEP_HEIGHT, STEP_WIDTH, stepTiles, thumbLayout,
} from "@/lib/workflow-canvas";
import type { WorkflowDraft } from "@/state/workflows";

const bot = (id: string, x: number, y: number): WorkflowStep => ({ id, kind: "bot", botId: "scout", instruction: "Do it", position: { x, y } });
const check = (id: string, x: number, y: number): WorkflowStep => ({ id, kind: "check", question: "Is it fine?", position: { x, y } });
const note = (id: string, x: number, y: number): WorkflowStep => ({ id, kind: "note", text: "Remember", position: { x, y } });
const draft = (steps: WorkflowStep[], connections: WorkflowDraft["connections"] = []): WorkflowDraft => ({ name: "Flow", steps, connections });

describe("the workflow canvas geometry", () => {
  it("snaps positions to the 8 px grid", () => {
    expect(snap({ x: 3, y: 5 })).toEqual({ x: 0, y: 8 });
    expect(snap({ x: 13, y: -13 })).toEqual({ x: 16, y: -16 });
    expect(draftReducer(draft([bot("a", 0, 0)]), { type: "move", stepId: "a", position: { x: 21, y: 35 } }).steps[0]!.position).toEqual({ x: 24, y: 32 });
  });

  it("finds a free spot near a point that no step covers", () => {
    const near = { x: 400, y: 300 };
    const empty = freeSpot([], near);
    expect(empty).toEqual(snap({ x: near.x - STEP_WIDTH / 2, y: near.y - STEP_HEIGHT / 2 }));
    const taken = [bot("a", empty.x, empty.y)];
    const spot = freeSpot(taken, near);
    const tile = stepTiles(taken)[0]!;
    const apart = spot.x >= tile.x + tile.width + 24 || spot.x + STEP_WIDTH + 24 <= tile.x || spot.y >= tile.y + tile.height + 24 || spot.y + STEP_HEIGHT + 24 <= tile.y;
    expect(apart).toBe(true);
    expect(spot.x % 8).toBe(0);
    expect(spot.y % 8).toBe(0);
  });

  it("draws a connection from the bottom of a step to the top of the next, with Yes left and No right on a check", () => {
    const from = check("a", 0, 0);
    const to = bot("b", 0, 200);
    expect(portPoint(from, "out")).toEqual({ x: STEP_WIDTH / 2, y: STEP_HEIGHT });
    expect(portPoint(from, "yes").x).toBeLessThan(portPoint(from, "no").x);
    expect(portPoint(from, "yes").y).toBe(STEP_HEIGHT);
    expect(inPoint(to)).toEqual({ x: STEP_WIDTH / 2, y: 200 });
    expect(edgePath({ x: 10, y: 20 }, { x: 10, y: 220 })).toBe("M 10 20 C 10 120, 10 120, 10 220");
    expect(edgePath({ x: 0, y: 0 }, { x: 5, y: 10 })).toBe("M 0 0 C 0 40, 5 -30, 5 10");
    expect(edgeMid({ x: 0, y: 0 }, { x: 100, y: 200 })).toEqual({ x: 50, y: 100 });
  });

  it("adds a step and connects it after the selected step when that step has a free slot", () => {
    const base = draft([bot("a", 0, 0)]);
    const added = draftReducer(base, { type: "add", step: bot("b", 0, 200), after: { stepId: "a", connectionId: "c1" } });
    expect(added.steps.map((step) => step.id)).toEqual(["a", "b"]);
    expect(added.connections).toEqual([{ id: "c1", from: "a", to: "b" }]);
    const full = draftReducer(added, { type: "add", step: bot("c", 0, 400), after: { stepId: "a", connectionId: "c2" } });
    expect(full.connections).toHaveLength(1);
    const afterCheck = draftReducer(draft([check("k", 0, 0)]), { type: "add", step: bot("y", 0, 200), after: { stepId: "k", connectionId: "c1" } });
    const second = draftReducer(afterCheck, { type: "add", step: bot("n", 300, 200), after: { stepId: "k", connectionId: "c2" } });
    expect(second.connections.map((connection) => connection.branch)).toEqual(["yes", "no"]);
    const afterNote = draftReducer(draft([note("n", 0, 0)]), { type: "add", step: bot("b", 0, 200), after: { stepId: "n", connectionId: "c1" } });
    expect(afterNote.connections).toEqual([]);
  });

  it("replaces the outgoing connection of a step, and only the same branch of a check", () => {
    const steps = [bot("a", 0, 0), bot("b", 0, 200), bot("c", 300, 200)];
    const first = draftReducer(draft(steps, [{ id: "c1", from: "a", to: "b" }]), { type: "connect", connection: { id: "c2", from: "a", to: "c" } });
    expect(first.connections).toEqual([{ id: "c2", from: "a", to: "c" }]);
    const branches = draft([check("k", 0, 0), bot("y", 0, 200), bot("n", 300, 200)], [
      { id: "c1", from: "k", to: "y", branch: "yes" },
      { id: "c2", from: "k", to: "n", branch: "no" },
    ]);
    const next = draftReducer(branches, { type: "connect", connection: { id: "c3", from: "k", to: "n", branch: "yes" } });
    expect(next.connections).toEqual([{ id: "c2", from: "k", to: "n", branch: "no" }, { id: "c3", from: "k", to: "n", branch: "yes" }]);
  });

  it("refuses a connection to itself, a note, or one that makes a loop, and leaves the draft unchanged", () => {
    const base = draft([bot("a", 0, 0), bot("b", 0, 200), note("n", 300, 0)], [{ id: "c1", from: "a", to: "b" }]);
    expect(draftReducer(base, { type: "connect", connection: { id: "x", from: "a", to: "a" } })).toBe(base);
    expect(draftReducer(base, { type: "connect", connection: { id: "x", from: "a", to: "n" } })).toBe(base);
    expect(draftReducer(base, { type: "connect", connection: { id: "x", from: "b", to: "a" } })).toBe(base);
  });

  it("removes a step with its connections and brings both back on restore", () => {
    const base = draft([bot("a", 0, 0), bot("b", 0, 200), bot("c", 0, 400)], [{ id: "c1", from: "a", to: "b" }, { id: "c2", from: "b", to: "c" }]);
    const removal = removalOf(base, "b")!;
    expect(removal.index).toBe(1);
    expect(removal.connections.map((connection) => connection.id)).toEqual(["c1", "c2"]);
    const removed = draftReducer(base, { type: "remove", stepId: "b" });
    expect(removed.steps.map((step) => step.id)).toEqual(["a", "c"]);
    expect(removed.connections).toEqual([]);
    const restored = draftReducer(removed, { type: "restore", removal });
    expect(restored.steps.map((step) => step.id)).toEqual(["a", "b", "c"]);
    expect(restored.connections.map((connection) => connection.id).sort()).toEqual(["c1", "c2"]);
    expect(removalOf(base, "missing")).toBeNull();
  });

  it("restores only the connections whose slot is still free", () => {
    const base = draft([bot("a", 0, 0), bot("b", 0, 200), bot("c", 0, 400)], [{ id: "c1", from: "a", to: "b" }, { id: "c2", from: "b", to: "c" }]);
    const removal = removalOf(base, "b")!;
    const removed = draftReducer(base, { type: "remove", stepId: "b" });
    const rewired = draftReducer(removed, { type: "connect", connection: { id: "c9", from: "a", to: "c" } });
    const restored = draftReducer(rewired, { type: "restore", removal });
    expect(restored.connections.map((connection) => connection.id).sort()).toEqual(["c2", "c9"]);
    const loop = draftReducer(removed, { type: "connect", connection: { id: "c8", from: "c", to: "a" } });
    const noLoop = draftReducer(loop, { type: "restore", removal });
    expect(noLoop.connections.map((connection) => connection.id).sort()).toEqual(["c1", "c8"]);
  });

  it("fits the steps into the view between 30% and 100%", () => {
    expect(fitSteps([], 800, 600)).toEqual({ x: 40, y: 40, scale: 1 });
    expect(fitSteps([bot("a", 0, 0)], 0, 0)).toEqual({ x: 40, y: 40, scale: 1 });
    expect(fitSteps([bot("a", 0, 0)], 2000, 1500).scale).toBe(1);
    const wide = fitSteps([bot("a", 0, 0), bot("b", 3000, 0)], 800, 600);
    expect(wide.scale).toBeGreaterThanOrEqual(0.3);
    expect(wide.scale).toBeLessThan(1);
    expect(fitSteps([bot("a", 0, 0), bot("b", 90_000, 0)], 800, 600).scale).toBe(0.3);
  });

  it("lays out a thumbnail inside its box", () => {
    const graph = draft([bot("a", 0, 0), bot("b", 0, 200), note("n", 400, 0)], [{ id: "c1", from: "a", to: "b" }, { id: "c2", from: "a", to: "gone" }]);
    const { boxes, lines } = thumbLayout(graph, 120, 72);
    expect(boxes).toHaveLength(3);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(120);
      expect(box.y + box.height).toBeLessThanOrEqual(72);
    }
    expect(lines.map((line) => line.id)).toEqual(["c1"]);
    expect(thumbLayout(draft([]), 120, 72)).toEqual({ boxes: [], lines: [] });
  });

  it("makes steps with defaults for each kind", () => {
    expect(newStep("wait", { x: 3, y: 5 })).toMatchObject({ kind: "wait", minutes: 60, position: { x: 0, y: 8 } });
    expect(newStep("bot", { x: 0, y: 0 }, "scout")).toMatchObject({ kind: "bot", botId: "scout", instruction: "" });
    expect(newStep("check", { x: 0, y: 0 }).id).toMatch(/^s-[\w-]{1,8}$/);
  });
});
