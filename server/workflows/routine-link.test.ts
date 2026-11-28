import { describe, expect, it } from "vitest";

import type { Workflow } from "../../shared/workflows.ts";
import { ROUTINE_CHECKS } from "../../shared/routines.ts";
import { sanitizeInput } from "../routine-input.ts";
import { linkWorkflow, workflowCopy, workflowLookupFor, workflowPromptCopy } from "./routine-link.ts";

const names: Record<string, string> = { ana: "Ana", ben: "Ben" };
const botName = (id: string) => names[id];
const at = { x: 0, y: 0 };

const flow = (over: Partial<Workflow> = {}): Workflow => ({
  id: "w1", name: "Morning", createdAt: 1, updatedAt: 1,
  steps: [
    { id: "a", kind: "bot", botId: "ana", instruction: "Collect the news", position: at },
    { id: "c", kind: "check", question: "Is there news?", position: at },
    { id: "b", kind: "bot", botId: "ben", instruction: "Write the digest", position: at },
    { id: "w", kind: "wait", minutes: 1, position: at },
    { id: "p", kind: "post", position: at },
    { id: "n", kind: "note", text: "memo", position: at },
  ],
  connections: [
    { id: "1", from: "a", to: "c" }, { id: "2", from: "c", to: "b", branch: "yes" }, { id: "3", from: "c", to: "w", branch: "no" },
    { id: "4", from: "b", to: "p" }, { id: "5", from: "w", to: "p" },
  ],
  ...over,
});

describe("the prompt copy of a workflow", () => {
  it("lists the steps in order, with the branch targets of a check", () => {
    expect(workflowPromptCopy(flow(), botName)).toBe([
      'This routine runs the workflow "Morning". Do these steps in order:',
      "1. Ana: Collect the news",
      "2. AI check: Is there news? If yes, go to 3. If no, go to 5.",
      "3. Ben: Write the digest",
      "4. Post results. Then finish.",
      "5. Wait 1 minute. Then go to 4.",
    ].join("\n"));
  });

  it("says where each step goes when the next number is not its next step", () => {
    const branched = flow({
      steps: [
        { id: "a", kind: "bot", botId: "ana", instruction: "A", position: at },
        { id: "c", kind: "check", question: "Check?", position: at },
        { id: "b", kind: "bot", botId: "ben", instruction: "B", position: at },
        { id: "p", kind: "post", position: at },
        { id: "d", kind: "bot", botId: "ana", instruction: "D", position: at },
      ],
      connections: [
        { id: "1", from: "a", to: "c" }, { id: "2", from: "c", to: "b", branch: "yes" }, { id: "3", from: "c", to: "d", branch: "no" },
        { id: "4", from: "b", to: "p" },
      ],
    });
    expect(workflowPromptCopy(branched, botName)).toBe([
      'This routine runs the workflow "Morning". Do these steps in order:',
      "1. Ana: A",
      "2. AI check: Check? If yes, go to 3. If no, go to 5.",
      "3. Ben: B",
      "4. Post results. Then finish.",
      "5. Ana: D",
    ].join("\n"));
  });

  it("says where a wait goes when it does not lead to the next number", () => {
    const jumping = flow({
      steps: [
        { id: "a", kind: "bot", botId: "ana", instruction: "A", position: at },
        { id: "c", kind: "check", question: "Check?", position: at },
        { id: "b", kind: "bot", botId: "ben", instruction: "B", position: at },
        { id: "p", kind: "post", position: at },
        { id: "w", kind: "wait", minutes: 5, position: at },
      ],
      connections: [
        { id: "1", from: "a", to: "c" }, { id: "2", from: "c", to: "b", branch: "yes" }, { id: "3", from: "c", to: "w", branch: "no" },
        { id: "4", from: "b", to: "p" }, { id: "5", from: "w", to: "p" },
      ],
    });
    expect(workflowPromptCopy(jumping, botName).split("\n").slice(1)).toEqual([
      "1. Ana: A",
      "2. AI check: Check? If yes, go to 3. If no, go to 5.",
      "3. Ben: B",
      "4. Post results. Then finish.",
      "5. Wait 5 minutes. Then go to 4.",
    ]);
  });

  it("leaves a note out", () => {
    expect(workflowPromptCopy(flow(), botName)).not.toContain("memo");
  });

  it("says a check with no branch finishes", () => {
    const copy = workflowPromptCopy(flow({ connections: [{ id: "1", from: "a", to: "c" }] }), botName);
    expect(copy).toContain("If yes, finish. If no, finish.");
  });

  it("says when a workflow has no steps", () => {
    expect(workflowPromptCopy(flow({ steps: [], connections: [] }), botName)).toBe('This routine runs the workflow "Morning". It has no steps yet.');
  });

  it("clips a long instruction and the whole copy", () => {
    const long = flow({ steps: [{ id: "a", kind: "bot", botId: "ana", instruction: "x".repeat(5_000), position: at }], connections: [] });
    expect(workflowPromptCopy(long, botName).length).toBeLessThan(2_200);
    const many = flow({
      steps: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, kind: "bot" as const, botId: "ana", instruction: "y".repeat(1_900), position: at })),
      connections: Array.from({ length: 49 }, (_, i) => ({ id: `k${i}`, from: `s${i}`, to: `s${i + 1}` })),
    });
    expect(workflowPromptCopy(many, botName).length).toBeLessThanOrEqual(20_000);
  });
});

describe("the routine fields a workflow sets", () => {
  it("takes the first bot as the routine's bot, and lists every bot once", () => {
    expect(workflowCopy(flow(), botName)).toEqual({ workflowId: "w1", prompt: workflowPromptCopy(flow(), botName), botId: "ana", botIds: ["ana", "ben"] });
  });
});

describe("linking a routine to a workflow", () => {
  const copy = workflowCopy(flow(), botName);

  it("sets nothing when the input names no workflow", () => {
    expect(linkWorkflow({}, undefined)).toBeNull();
    expect(linkWorkflow({ workflowId: null }, () => copy)).toBeNull();
  });

  it("returns the copy of a workflow that exists", () => {
    expect(linkWorkflow({ workflowId: "w1" }, () => copy)).toBe(copy);
  });

  it("refuses a workflow that is gone, or when workflows are unavailable", () => {
    expect(() => linkWorkflow({ workflowId: "w9" }, () => null)).toThrow("That workflow is gone. Choose another one.");
    expect(() => linkWorkflow({ workflowId: "w9" }, undefined)).toThrow("That workflow is gone. Choose another one.");
  });

  it("refuses a workflow that cannot run yet, with the problem's own words", () => {
    expect(() => linkWorkflow({ workflowId: "w1" }, () => ({ code: "workflow_no_start", message: "Add a bot step to start this workflow." }))).toThrow("Add a bot step to start this workflow.");
  });
});

describe("accepts every setting", () => {
  const two = (): Workflow => ({
    id: "w1", name: "Morning", createdAt: 1, updatedAt: 1,
    steps: [{ id: "a", kind: "bot", botId: "ana", instruction: "Collect", position: at }, { id: "b", kind: "bot", botId: "ben", instruction: "Write", position: at }],
    connections: [{ id: "1", from: "a", to: "b" }],
  });
  const lookup = () => workflowCopy(two(), botName);
  const base = { name: "Morning", workflowId: "w1", prompt: "unused", botId: "unused", schedule: { type: "interval" as const, everyMinutes: 60, anchorAt: 1 } };
  const save = (change: Record<string, unknown>) => sanitizeInput({ ...base, ...change } as never, 0, lookup);

  it.each([
    ["a cloud desktop", { runOn: "cloud" }, { runOn: "cloud" }],
    ["delivery to the brief", { deliver: "brief" }, { deliver: "brief" }],
    ["the same conversation", { sameConversation: true }, { sameConversation: true }],
    ["a chosen model", { modelSelection: { instanceId: "codex", model: "gpt-x" } }, { modelSelection: { instanceId: "codex", model: "gpt-x" } }],
    ["a start at the limit reset", { schedule: { type: "limit_reset", engine: "claude", repeat: "once" } }, { schedule: { type: "limit_reset" } }],
    ["read-and-draft access", { access: "read-and-draft" }, { access: "read-and-draft" }],
    ["checks", { checks: [ROUTINE_CHECKS[0]] }, { checks: [ROUTINE_CHECKS[0]] }],
  ])("saves %s on a workflow with two steps", (_name, change, kept) => {
    expect(save(change)).toMatchObject({ workflowId: "w1", workflowBotIds: ["ana", "ben"], botId: "ana", ...kept });
  });
});

describe("a room goal", () => {
  const lookup = () => workflowCopy({ id: "w1", name: "M", createdAt: 1, updatedAt: 1, steps: [{ id: "a", kind: "bot", botId: "ana", instruction: "Go", position: at }], connections: [] }, botName);
  const goal = (change: Record<string, unknown> = {}) =>
    sanitizeInput({ name: "M", workflowId: "w1", prompt: "x", botId: "ana", target: "room-goal", groupId: "room-1", schedule: { type: "interval", everyMinutes: 60, anchorAt: 1 }, ...change } as never, 0, lookup);
  const refusal = (change: Record<string, unknown>) => { try { goal(change); } catch (error) { return { message: (error as Error).message, status: (error as { status?: number }).status }; } return null; };

  it("keeps the workflow and the room of a goal that runs steps", () => {
    expect(goal()).toMatchObject({ target: "room-goal", groupId: "room-1", workflowId: "w1", workflowBotIds: ["ana"] });
  });

  it("refuses steps without a room, and reads and drafts only, with plain words and a 400", () => {
    expect(refusal({ groupId: "" })).toEqual({ message: "Choose a room for this goal.", status: 400 });
    expect(refusal({ access: "read-and-draft" })).toEqual({ message: "A room goal can't be set to reads and drafts only. Turn that off for the automation and each step.", status: 400 });
  });
});

describe("the lookup an edit of a linked routine uses", () => {
  const held = { prompt: "stored copy", botId: "ana", workflowId: "w1", workflowBotIds: ["ana", "ben"] };
  const fresh = () => workflowCopy(flow(), botName);

  it("returns the stored copy when the edit names no workflow", () => {
    const lookup = workflowLookupFor({}, held, () => null)!;
    expect(lookup("w1")).toEqual({ workflowId: "w1", prompt: "stored copy", botId: "ana", botIds: ["ana", "ben"] });
  });

  it("looks the workflow up when the edit names one or asks for a rewrite", () => {
    const real = () => fresh();
    expect(workflowLookupFor({ workflowId: "w1" }, held, real)).toBe(real);
    expect(workflowLookupFor({ rewriteWorkflow: true }, held, real)).toBe(real);
  });
});
