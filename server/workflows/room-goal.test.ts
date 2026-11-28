import { describe, expect, it } from "vitest";

import type { WorkflowStep } from "../../shared/workflows.ts";
import { roomGoalProblem, roomGoalSaveRefusal } from "./room-goal.ts";

const at = { x: 0, y: 0 };
const names: Record<string, string> = { ana: "Ana", ben: "Ben" };
const botName = (id: string) => names[id];
const steps = (...more: WorkflowStep[]): { steps: WorkflowStep[] } => ({
  steps: [
    { id: "a", kind: "bot", botId: "ana", instruction: "Collect", position: at },
    { id: "b", kind: "bot", botId: "ben", instruction: "Write", position: at },
    ...more,
  ],
});
const room = { memberIds: ["ana", "ben"] };

describe("the room check of a room goal", () => {
  it("lets a goal run when every bot of its steps is in the room", () => {
    expect(roomGoalProblem(steps(), room, botName)).toBeNull();
  });

  it("names the bot that is not in the room, with a 403", () => {
    expect(roomGoalProblem(steps(), { memberIds: ["ana"] }, botName)).toEqual({ status: 403, error: "Ben isn't in this room. Add Ben to the room first." });
  });

  it("refuses a goal with no room, a gone room or a one-to-one chat", () => {
    expect(roomGoalProblem(steps(), undefined, botName)?.error).toBe("Choose a room for this goal.");
    expect(roomGoalProblem(steps(), null, botName)?.status).toBe(400);
    expect(roomGoalProblem(steps(), { memberIds: ["ana", "ben"], dm: true }, botName)?.status).toBe(400);
  });

  it("refuses a step that chooses a model, and reads and drafts only on the goal or a step", () => {
    const model = { instanceId: "codex", model: "gpt-x" };
    expect(roomGoalProblem({ steps: [{ id: "a", kind: "bot", botId: "ana", instruction: "Go", position: at, modelSelection: model }] }, room, botName)?.status).toBe(400);
    expect(roomGoalProblem({ steps: [{ id: "a", kind: "bot", botId: "ana", instruction: "Go", position: at, access: "read-and-draft" }] }, room, botName)?.status).toBe(400);
    expect(roomGoalProblem(steps(), room, botName, "read-and-draft")?.error).toMatch(/reads and drafts only/);
  });
});

describe("the room check of a routine save", () => {
  const deps = { workflow: (id: string) => (id === "w1" ? steps() : null), room: (id: string) => (id === "room-1" ? { memberIds: ["ana"] } : null), botName };

  it("checks a room goal that runs a workflow, from the saved fields over the routine it changes", () => {
    expect(roomGoalSaveRefusal({ target: "room-goal", groupId: "room-1", workflowId: "w1" }, undefined, deps)?.status).toBe(403);
    expect(roomGoalSaveRefusal({ name: "New name" }, { target: "room-goal", groupId: "room-1", workflowId: "w1" }, deps)?.status).toBe(403);
    expect(roomGoalSaveRefusal({ access: null }, { target: "room-goal", groupId: "room-1", workflowId: "w1", access: "read-and-draft" }, deps)?.status).toBe(403);
  });

  it("leaves a bot routine, a goal without steps and an unlinked goal alone", () => {
    expect(roomGoalSaveRefusal({ target: "bot", groupId: "room-1", workflowId: "w1" }, undefined, deps)).toBeNull();
    expect(roomGoalSaveRefusal({ target: "room-goal", groupId: "room-1" }, undefined, deps)).toBeNull();
    expect(roomGoalSaveRefusal({ workflowId: null }, { target: "room-goal", groupId: "room-1", workflowId: "w1" }, deps)).toBeNull();
  });
});
