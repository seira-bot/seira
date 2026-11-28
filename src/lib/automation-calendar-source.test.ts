import { describe, expect, it } from "vitest";

import type { Routine, RoutineRun } from "@/lib/routines";
import type { WebhookTrigger } from "@/lib/webhooks";
import type { Workflow } from "../../shared/workflows";
import { calendarAutomations } from "./automation-calendar-source";

const NOW = new Date(2026, 10, 27, 18, 40).getTime();
const routine = (overrides: Partial<Routine>): Routine => ({
  id: "r1", name: "Morning summary", prompt: "Send me a summary.", target: "bot", botId: "scout", runOn: "seira", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: NOW + 3_600_000, createdAt: 100, updatedAt: 100, ...overrides,
});
const webhook = (overrides: Partial<WebhookTrigger> = {}): WebhookTrigger => ({
  id: "hook", endpointId: "wh_x", name: "Sales form leads", prompt: "Draft a reply.", botId: "scout", runOn: "seira", enabled: true, createdAt: 0, updatedAt: 0, deliveryCount: 0, ...overrides,
});
const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf1", name: "Weekly sales check", createdAt: 0, updatedAt: 0,
  steps: [
    { id: "a", kind: "bot", botId: "lumi", instruction: "Pull sales", position: { x: 0, y: 0 } },
    { id: "b", kind: "check", question: "Did they drop?", position: { x: 0, y: 0 } },
    { id: "c", kind: "bot", botId: "pippa", instruction: "Draft ideas", position: { x: 0, y: 0 } },
  ],
  connections: [], ...overrides,
});
const bots = [{ id: "scout" }, { id: "lumi" }, { id: "pippa" }];
const failedRun = (routineId: string, at: number): RoutineRun => ({
  id: `run-${routineId}-${at}`, routineId, routineName: "x", target: "bot", botId: "scout", runOn: "seira", scheduledFor: at, startedAt: at, createdAt: at, status: "failed", manual: false,
});

describe("calendarAutomations", () => {
  it("groups routines of one workflow into one automation with many starts and the workflow name", () => {
    const list = calendarAutomations({
      routines: [
        routine({ id: "mon", workflowId: "wf1", schedule: { type: "daily", time: "09:00", weekdays: [1] } }),
        routine({ id: "fri", workflowId: "wf1", schedule: { type: "daily", time: "16:00", weekdays: [5] } }),
        routine({ id: "solo", name: "Solo" }),
      ],
      webhooks: [], runs: [failedRun("mon", NOW - 1000)], bots, workflows: [workflow()],
    }, NOW);
    const grouped = list.find((item) => item.id === "wf1")!;
    expect(grouped.name).toBe("Weekly sales check");
    expect(grouped.starts.map((start) => start.id)).toEqual(expect.arrayContaining(["mon", "fri"]));
    expect(grouped.starts.length).toBe(2);
    expect(grouped.stepBotIds).toEqual(["lumi", "pippa"]);
    expect(grouped.runs.map((item) => item.routineId)).toEqual(["mon"]);
    expect(list.filter((item) => item.id !== "wf1").map((item) => item.id)).toEqual(["solo"]);
  });

  it("uses the bot of an automation without a workflow, and the routine own start details", () => {
    const [only] = calendarAutomations({ routines: [routine({})], webhooks: [webhook()], runs: [], bots }, NOW);
    expect(only!.stepBotIds).toEqual(["scout"]);
    expect(only!.starts[0]).toMatchObject({ kind: "schedule", id: "r1", enabled: true, createdAt: 100 });
    expect(only!.draft).toBe(false);
  });

  it("makes a webhook automation a webhook start", () => {
    const list = calendarAutomations({ routines: [], webhooks: [webhook()], runs: [], bots }, NOW);
    expect(list[0]!.starts).toEqual([{ id: "hook", kind: "webhook" }]);
  });

  it("flags needsYou and keeps the List order, needs-you first", () => {
    const list = calendarAutomations({
      routines: [routine({ id: "ok", name: "A fine one" }), routine({ id: "bad", name: "Zed broken" })],
      webhooks: [], bots,
      runs: [failedRun("bad", NOW - 2000), failedRun("bad", NOW - 1000)],
    }, NOW);
    expect(list.map((item) => item.id)).toEqual(["bad", "ok"]);
    expect(list.map((item) => item.needsYou)).toEqual([true, false]);
    expect(list[1]!.statusLine.length).toBeGreaterThan(0);
  });

  it("leaves out an automation whose bot is gone", () => {
    expect(calendarAutomations({ routines: [routine({ botId: "ghost" })], webhooks: [], runs: [], bots }, NOW)).toEqual([]);
  });

  it("lists a workflow with no start as a draft after the others", () => {
    const list = calendarAutomations({ routines: [routine({})], webhooks: [], runs: [], bots, workflows: [workflow()] }, NOW);
    expect(list.map((item) => [item.id, item.draft])).toEqual([["r1", false], ["wf1", true]]);
    expect(list[1]).toMatchObject({ enabled: false, starts: [], stepBotIds: ["lumi", "pippa"] });
  });
});
