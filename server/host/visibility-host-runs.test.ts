import { describe, expect, it } from "vitest";

import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import type { BotRecord } from "../store.ts";
import { createVisibilityHost } from "./visibility-host.ts";

const BOB: Viewer = { kind: "member", email: "bob@example.test" };
const bots = [
  { id: "pub", section: "Ops" },
  { id: "hr", section: "People", visibility: { people: ["ada@example.test"] } },
] as unknown as BotRecord[];
const runs = [
  { id: "plain", botId: "pub" },
  { id: "kept", botId: "pub", workflowId: "wf", workflowBotIds: ["pub"] },
  { id: "unlisted", botId: "pub", workflowId: "wf" },
  { id: "used-hr", botId: "pub", workflowId: "wf", workflowBotIds: ["pub", "hr"] },
];
const host = createVisibilityHost({
  store: () => ({
    bots, groups: [], bot: (id: string) => bots.find((one) => one.id === id), group: () => undefined,
    botByThread: () => undefined, groupByThread: () => undefined, patchGroup: () => undefined,
  }) as never,
  routines: () => ({ listRoutines: () => [], listRuns: () => runs }) as never,
  team: false,
  audiencesFor: () => undefined,
  threadsReferencing: () => [],
});

describe("who may act on a routine run by its id", () => {
  const bob = new VisibleSet(bots, [], BOB);
  const judged = (id: string) => host.subjectVisible({ kind: "routine-run", id }, bob);

  it("judges a run of a workflow by the bots it used, like the run list does", () => {
    expect(judged("plain")).toBe(true);
    expect(judged("kept")).toBe(true);
    expect(judged("used-hr")).toBe(false);
  });

  it("holds back a run of a workflow that kept no list of its bots", () => {
    expect(judged("unlisted")).toBe(false);
  });
});
