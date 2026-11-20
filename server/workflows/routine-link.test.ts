import { describe, expect, it } from "vitest";

import type { Workflow } from "../../shared/workflows.ts";
import { linkWorkflow, workflowCopy, workflowLookupFor, workflowPromptCopy, workflowRefusal } from "./routine-link.ts";

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

describe("what a routine must not have to run a workflow", () => {
  const clean = { target: "bot", runOn: "seira", scheduleType: "interval" };

  it("accepts a plain routine", () => {
    expect(workflowRefusal(clean)).toBeNull();
  });

  it.each([
    [{ access: "read-and-draft" }, "A workflow can't use read-only access."],
    [{ checks: ["links"] }, "A workflow can't use checks."],
    [{ runOn: "cloud" }, "A workflow runs on this computer."],
    [{ deliver: "brief" }, "A workflow posts its results with a Post results step."],
    [{ sameConversation: true }, "A workflow opens new chats for each run."],
    [{ scheduleType: "limit_reset" }, "A workflow can't continue a chat after a usage limit."],
  ])("refuses %j", (change, message) => {
    expect(workflowRefusal({ ...clean, ...change })).toBe(message);
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
