import { describe, expect, it } from "vitest";

import { bindThread, runOfThread } from "./routine-step-threads.ts";
import type { RoutineRun } from "./routines.ts";

const run = (id: string, status: RoutineRun["status"], access?: "read-and-draft"): RoutineRun =>
  ({ id, routineId: `r-${id}`, botId: "ana", status, workflowId: "wf", threadId: `own-${id}`, ...(access ? { access } : {}) }) as RoutineRun;

describe("runOfThread", () => {
  it.each([
    ["a waiting older run that reads and drafts only and a newer run with full access", "read-and-draft", undefined],
    ["a waiting older run with full access and a newer run that reads and drafts only", undefined, "read-and-draft"],
  ] as const)("gives a chat that %s share the stricter access, with the newer run's identity", (_name, olderAccess, newerAccess) => {
    const older = run("older", "waiting", olderAccess);
    const newer = run("newer", "running", newerAccess);
    bindThread(older, "shared");
    bindThread(newer, "shared");
    expect(runOfThread([older, newer], "shared")).toMatchObject({ id: "newer", access: "read-and-draft" });
    expect(newer.access).toBe(newerAccess);
  });

  it("gives a step's own stricter access in its chat", () => {
    const only = run("only", "running");
    bindThread(only, "step", "read-and-draft");
    expect(runOfThread([only], "step")).toMatchObject({ id: "only", access: "read-and-draft" });
    expect(runOfThread([only], "own-only")?.access).toBeUndefined();
  });

  it("uses the access of the live runs, not of a run that has ended", () => {
    const older = run("older", "completed", "read-and-draft");
    const newer = run("newer", "running");
    bindThread(older, "shared");
    bindThread(newer, "shared");
    expect(runOfThread([older, newer], "shared")).toMatchObject({ id: "newer" });
    expect(runOfThread([older, newer], "shared")?.access).toBeUndefined();
    expect(runOfThread([older, newer], "nobody")).toBeNull();
  });
});
