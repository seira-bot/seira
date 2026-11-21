import { describe, expect, it } from "vitest";

import type { Workflow } from "../../shared/workflows.ts";
import type { InternalTriggerContext } from "../app-trigger-host.ts";
import { createWorkflowAgentRoutes, type WorkflowAgentDeps } from "./workflow-agent.ts";
import { PASS, type RouteContext } from "./table.ts";

const scout = { id: "scout", name: "Scout", section: "" };
const ledger = { id: "ledger", name: "Ledger", section: "Ops" };
const peer = { id: "peer", name: "Peer", section: "" };
const bots = new Map([scout, ledger, peer].map((bot) => [bot.id, bot]));
const position = { x: 0, y: 0 };
const flow = (id: string, steps: Workflow["steps"]): Workflow => ({ id, name: `Flow ${id}`, createdAt: 1, updatedAt: 1, steps, connections: [] });
const botStep = (id: string, botId: string, instruction = "Do it") => ({ id, kind: "bot" as const, botId, instruction, position });

function harness(options: { guestDriven?: boolean; team?: boolean; saved?: Workflow[]; shown?: (workflow: { steps?: unknown }) => boolean; reach?: string[] } = {}) {
  const created: unknown[] = [];
  const saved = options.saved ?? [];
  const deps: WorkflowAgentDeps = {
    workflows: () => ({ list: () => saved, create: (input) => { created.push(input); return { ...input, id: "wf-new", createdAt: 1, updatedAt: 1 } as Workflow; } }),
    routines: () => ({ listRoutines: () => [] }),
    bot: (id) => bots.get(id) as never,
    reachableName: (_from, _thread, botId) => ((options.reach ?? ["scout", "ledger", "peer"]).includes(botId) ? bots.get(botId)?.name : undefined),
    shown: (workflow) => options.shown?.(workflow) ?? true,
    team: () => Boolean(options.team),
    creator: () => "owner",
  };
  const context = { from: scout, threadId: "t1", ownsThread: () => true, guestDriven: Boolean(options.guestDriven), outsideDriven: () => false, canCommit: () => true } as unknown as InternalTriggerContext;
  const handler = createWorkflowAgentRoutes(deps)(context);
  const call = async (method: "GET" | "POST", body?: unknown) => {
    let answer: { status: number; body: any } | undefined;
    const route = { req: {}, res: {}, url: new URL("http://x/api/internal/workflows"), path: "/api/internal/workflows", method,
      json: (_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; return true; }, readBody: async () => body } as unknown as RouteContext;
    const outcome = await handler(route);
    expect(outcome).not.toBe(PASS);
    return answer!;
  };
  return { call, created };
}

describe("workflow action=create for a bot", () => {
  it("saves a workflow of the caller's own steps", async () => {
    const { call, created } = harness();
    const answer = await call("POST", { name: "Daily", steps: [{ kind: "bot", instruction: "Collect" }, { kind: "post" }] });
    expect(answer.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  it("refuses a step for a bot the caller reaches but may not manage, and saves nothing", async () => {
    const { call, created } = harness();
    const answer = await call("POST", { name: "Daily", steps: [{ kind: "bot", instruction: "Collect" }, { kind: "bot", bot_id: "ledger", instruction: "Write" }] });
    expect(answer.status).toBe(403);
    expect(answer.body.error).toContain("automations are set up by bots in its own department");
    expect(created).toEqual([]);
  });

  it("allows a step for a bot the caller manages", async () => {
    const { call, created } = harness();
    expect((await call("POST", { name: "Pair", steps: [{ kind: "bot", instruction: "A" }, { kind: "bot", bot_id: "peer", instruction: "B" }] })).status).toBe(201);
    expect(created).toHaveLength(1);
  });

  it("refuses on a Team Cloud", async () => {
    const { call, created } = harness({ team: true });
    expect((await call("POST", { name: "Daily", steps: [{ kind: "bot", instruction: "Collect" }] })).status).toBe(403);
    expect(created).toEqual([]);
  });
});

describe("trigger_info action=workflows", () => {
  const own = flow("own", [botStep("a", "scout", "Collect"), { id: "c", kind: "check", question: "Is it ready?", position }]);
  const withUnreachable = flow("hidden-q", [botStep("a", "scout"), { id: "c", kind: "check", question: "Secret question?", position }, botStep("b", "ledger")]);

  it("refuses a turn a guest drives", async () => {
    const answer = await harness({ guestDriven: true, saved: [own] }).call("GET");
    expect(answer.status).toBe(403);
  });

  it("leaves out a workflow the person behind the turn cannot see", async () => {
    const answer = await harness({ saved: [own, withUnreachable], shown: (workflow) => workflow !== withUnreachable }).call("GET");
    expect(answer.body.workflows.map((one: { id: string }) => one.id)).toEqual(["own"]);
  });

  it("hides a check's question when a step belongs to a bot this turn cannot reach", async () => {
    const answer = await harness({ saved: [own, withUnreachable], reach: ["scout"] }).call("GET");
    const byId = Object.fromEntries(answer.body.workflows.map((one: { id: string; steps: Array<{ kind: string; question?: string }> }) => [one.id, one]));
    expect(byId.own.steps.find((step: { kind: string }) => step.kind === "check").question).toBe("Is it ready?");
    expect(byId["hidden-q"].steps.find((step: { kind: string }) => step.kind === "check")).toEqual({ kind: "check" });
  });
});
