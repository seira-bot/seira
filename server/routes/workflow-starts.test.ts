import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import type { Workflow, WorkflowInput, WorkflowRun } from "../../shared/workflows.ts";
import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import { createWorkflowStarts } from "../host/workflow-starts.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import { RoutineManager } from "../routines.ts";
import { WebhookManager } from "../webhooks.ts";
import { workflowCopy } from "../workflows/routine-link.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createWorkflowRoutes, startLinkRefusal, workflowTargetHidden } from "./workflows.ts";

const BOB: Viewer = { kind: "member", email: "bob@example.test" };
const bots = [
  { id: "pub", threadId: "t-pub" },
  { id: "hr", threadId: "t-hr", visibility: { people: ["ada@example.test"] } },
];
const names: Record<string, string> = { pub: "Pia", hr: "Hal" };
const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const member = { kind: "session", via: "cookie", scopes: ["client"] } as unknown as RequestAuth;
const position = { x: 0, y: 0 };
const botStep = (id: string, botId: string) => ({ id, kind: "bot" as const, botId, instruction: "Do the work.", position });

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rig(over: { levels?: Record<string, BotAccessLevel>; appRefusal?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wfs-"));
  dirs.push(dir);
  const flows = new Map<string, Workflow>();
  const workflowRuns = new Map<string, WorkflowRun>();
  const again: string[] = [];
  const apps: Array<{ id: string; name: string; enabled: boolean; botId: string; app: string; workflowId?: string }> = [];
  let made = 0;
  const add = (id: string, ...botIds: string[]) => {
    const flow: Workflow = {
      id, name: `Flow ${id}`, createdAt: 1, updatedAt: 1,
      steps: botIds.map((botId, index) => botStep(`s${index + 1}`, botId)),
      connections: botIds.slice(1).map((_, index) => ({ id: `c${index + 1}`, from: `s${index + 1}`, to: `s${index + 2}` })),
    };
    flows.set(id, flow);
    return flow;
  };
  const lookup = (id: string) => {
    const flow = flows.get(id);
    return flow ? workflowCopy(flow, (botId) => names[botId]) : null;
  };
  const host = {
    list: () => [...flows.values()],
    get: (id: string) => flows.get(id) ?? null,
    creator: () => "me",
    create: (input: WorkflowInput) => { const flow = { ...input, id: `new-${++made}`, createdAt: 9, updatedAt: 9 } as Workflow; flows.set(flow.id, flow); return flow; },
    remove: (id: string) => flows.delete(id),
    runs: () => [],
    run: (id: string) => workflowRuns.get(id) ?? null,
    runAgainFromEvent: (runId: string, stepId: string, startId: string) => { again.push(`${runId} ${stepId} ${startId}`); return { id: "run-new" }; },
  } as unknown as WorkflowHost;
  const routines = new RoutineManager({
    file: join(dir, "routines.json"), botState: () => "busy", createTask: () => ({ threadId: "thread" }), startTurn: async () => {}, workflowCopy: lookup,
  });
  closers.push(() => routines.close());
  const webhooks = new WebhookManager({ file: join(dir, "webhooks.json"), botState: () => "ready", enqueue: () => ({ id: "run" }), workflowCopy: lookup });
  const starts = createWorkflowStarts({ routines: () => routines, webhooks: () => webhooks, appTriggers: () => ({
    list: () => apps as never,
    update: async (id: string, patch: { enabled?: boolean }) => { const found = apps.find((candidate) => candidate.id === id); if (found && patch.enabled !== undefined) found.enabled = patch.enabled; return null; },
  }), appAccessRefusal: () => over.appRefusal ?? null });
  const visible = new VisibleSet(bots, [], BOB);
  const botsRefusal = (_auth: RequestAuth, ids: readonly string[], needed: "chat" | "edit") =>
    (ids.some((id) => !atLeast(over.levels?.[id] ?? "edit", needed)) ? "You can't change this bot." : null);
  const deps = {
    visible: () => visible, botName: (id: string) => names[id], workflows: () => host, routines: () => routines, starts: () => starts,
    routineEdits: { writer: () => "me", refusal: () => null, edit: <T>(_auth: RequestAuth, _routines: unknown, change: () => T) => change() },
    botsRefusal, routineNeeds: () => "chat" as const,
  };
  const routes = createWorkflowRoutes(deps);
  async function call(method: string, path: string, body?: unknown, who: RequestAuth = auth) {
    const sent: { status?: number; body?: any } = {};
    const context = {
      req: {} as RouteContext["req"], res: {} as RouteContext["res"], url: new URL(`http://x${path}`), path, method, auth: who,
      json: ((_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as unknown as RouteContext["json"],
      readBody: (async () => body) as unknown as RouteContext["readBody"],
    } as RouteContext;
    const out = await routes(context);
    return { out, ...sent };
  }
  const routine = (over: Record<string, unknown> = {}) => routines.create({
    name: "Morning news", prompt: "Summarize the news", botId: "pub", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.parse("2026-11-27T08:00:00Z") }, ...over,
  } as never);
  const webhook = (over: Record<string, unknown> = {}) => webhooks.create({ name: "Orders", prompt: "Check the order", botId: "pub", ...over }).webhook;
  return { flows, add, host, workflowRuns, again, apps, routines, webhooks, starts, visible, deps, call, routine, webhook, botsRefusal };
}

describe("one switch for every start of an automation", () => {
  it("turns every start of an automation on and off", async () => {
    const r = rig();
    r.add("wf-1", "pub", "pub");
    r.routine({ workflowId: "wf-1" });
    const hook = r.webhook({ workflowId: "wf-1" });
    const other = r.webhook({ name: "Other", prompt: "Plain" });

    const off = await r.call("POST", "/api/workflows/wf-1/switch", { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.starts.map((start: { kind: string; enabled: boolean }) => [start.kind, start.enabled])).toEqual([["routine", false], ["webhook", false]]);
    expect(r.routines.listRoutines()[0]!.enabled).toBe(false);
    expect(r.webhooks.list().find((candidate) => candidate.id === hook.id)!.enabled).toBe(false);
    expect(r.webhooks.list().find((candidate) => candidate.id === other.id)!.enabled).toBe(true);

    const on = await r.call("POST", "/api/workflows/wf-1/switch", { enabled: true });
    expect(on.body.starts.every((start: { enabled: boolean }) => start.enabled)).toBe(true);
    expect(r.routines.listRoutines()[0]!.enabled).toBe(true);
  });

  it("refuses the switch when an automation has no start", async () => {
    const r = rig();
    r.add("wf-1", "pub");
    const refused = await r.call("POST", "/api/workflows/wf-1/switch", { enabled: true });
    expect(refused).toMatchObject({ status: 409, body: { error: "Choose what starts it first." } });
    expect((await r.call("POST", "/api/workflows/wf-1/switch", { enabled: "yes" })).status).toBe(400);
  });

  it("delete one of two starts", async () => {
    const r = rig();
    r.add("wf-1", "pub");
    const routine = r.routine({ workflowId: "wf-1" });
    const hook = r.webhook({ workflowId: "wf-1" });
    expect(r.starts.list("wf-1").map((start) => start.kind)).toEqual(["routine", "webhook"]);

    expect(r.webhooks.remove(hook.id)).toBe(true);
    expect(r.flows.has("wf-1")).toBe(true);
    expect(r.starts.list("wf-1").map((start) => start.kind)).toEqual(["routine"]);

    expect(r.routines.remove(routine.id)).toBe(true);
    expect(r.flows.has("wf-1")).toBe(true);
    expect(r.starts.list("wf-1")).toEqual([]);
    expect((await r.call("GET", "/api/workflows/wf-1")).status).toBe(200);
    expect((await r.call("POST", "/api/workflows/wf-1/switch", { enabled: true })).status).toBe(409);
  });
});

describe("turning a start into steps", () => {
  it("second step keeps starts, settings and run history", async () => {
    const r = rig();
    const routine = r.routine({ overlap: "queue", durationMinutes: 45, runOnStartup: true });
    const run = r.routines.runNow(routine.id)!;
    const hook = r.webhook();

    const made = await r.call("POST", "/api/workflows/from-start", { kind: "routine", id: routine.id });
    expect(made.status).toBe(201);
    expect(made.body.workflow.steps).toMatchObject([{ kind: "bot", botId: "pub", instruction: "Summarize the news" }]);
    expect(made.body.start).toMatchObject({ kind: "routine", id: routine.id });
    const after = r.routines.listRoutines();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: routine.id, workflowId: made.body.workflow.id, overlap: "queue", durationMinutes: 45, runOnStartup: true, schedule: routine.schedule });
    expect(r.routines.listRuns().map((candidate) => candidate.id)).toContain(run.id);

    const second = await r.call("POST", "/api/workflows/from-start", { kind: "webhook", id: hook.id });
    expect(second.status).toBe(201);
    const linked = r.webhooks.list().find((candidate) => candidate.id === hook.id)!;
    expect(linked).toMatchObject({ workflowId: second.body.workflow.id, endpointId: hook.endpointId });
    expect(r.flows.size).toBe(2);

    expect((await r.call("POST", "/api/workflows/from-start", { kind: "routine", id: routine.id })).body.error).toBe("This already runs steps.");
  });

  it("turns an automation with a chosen model into steps, and keeps the model", async () => {
    const r = rig();
    const routine = r.routine({ modelSelection: { instanceId: "codex", model: "gpt-x" } });
    const made = await r.call("POST", "/api/workflows/from-start", { kind: "routine", id: routine.id });
    expect(made.status).toBe(201);
    expect(r.routines.listRoutines()[0]).toMatchObject({ workflowId: made.body.workflow.id, modelSelection: { instanceId: "codex", model: "gpt-x" } });

    const empty = r.webhook({ name: "Blank", prompt: "  " });
    expect((await r.call("POST", "/api/workflows/from-start", { kind: "webhook", id: empty.id })).body.error).toBe("Write what the bot should do first.");
    expect(r.flows.size).toBe(1);
  });
});

describe("who may change an automation", () => {
  it("refuses a person who cannot see every bot", async () => {
    const r = rig();
    r.add("secret", "pub", "hr");
    expect((await r.call("POST", "/api/workflows/secret/switch", { enabled: true })).status).toBe(404);

    const hidden = r.routine({ name: "Hal's", botId: "hr" });
    expect((await r.call("POST", "/api/workflows/from-start", { kind: "routine", id: hidden.id })).status).toBe(404);
    const hook = r.webhook({ name: "Hal hook", botId: "hr" });
    expect((await r.call("POST", "/api/workflows/from-start", { kind: "webhook", id: hook.id })).status).toBe(404);
    expect(r.flows.size).toBe(1);

    expect(startLinkRefusal({ workflowId: "secret" }, undefined, auth, r.host, r.visible, r.deps)).toEqual({ status: 404, error: "no such workflow" });
    r.add("open", "pub");
    r.add("old", "pub", "hr");
    expect(startLinkRefusal({ workflowId: "open" }, "old", auth, r.host, r.visible, r.deps)).toEqual({ status: 404, error: "no such workflow" });
    expect(startLinkRefusal({ workflowId: "open" }, undefined, auth, r.host, r.visible, r.deps)).toBeNull();
  });

  it("refuses a workflow id that does not resolve", async () => {
    const r = rig();
    r.add("secret", "pub", "hr");
    expect(startLinkRefusal({ workflowId: "gone" }, undefined, auth, r.host, r.visible, r.deps)).toEqual({ status: 404, error: "no such workflow" });
    expect(startLinkRefusal({ workflowId: " secret " }, undefined, auth, r.host, r.visible, r.deps)).toEqual({ status: 404, error: "no such workflow" });
    expect(startLinkRefusal({ workflowId: "secret" }, undefined, auth, r.host, r.visible, r.deps)).toEqual({ status: 404, error: "no such workflow" });
    expect(startLinkRefusal({}, undefined, auth, r.host, r.visible, r.deps)).toBeNull();
    expect(workflowTargetHidden({ workflowId: " secret " }, r.visible, r.host)).toBe("no such workflow");
    expect(() => r.webhook({ workflowId: " secret " })).toThrow();
    expect(r.webhooks.list()).toHaveLength(0);
  });

  it("refuses a person with view access only", async () => {
    const r = rig({ levels: { pub: "view" } });
    r.add("wf-1", "pub");
    r.routine({ workflowId: "wf-1" });
    const plain = r.routine({ name: "Plain" });
    expect((await r.call("POST", "/api/workflows/wf-1/switch", { enabled: false })).status).toBe(403);
    expect(r.routines.listRoutines().every((routine) => routine.enabled)).toBe(true);
    expect((await r.call("POST", "/api/workflows/from-start", { kind: "routine", id: plain.id })).status).toBe(403);
    expect(r.flows.size).toBe(1);
    expect(startLinkRefusal({ workflowId: "wf-1" }, undefined, auth, r.host, r.visible, r.deps)).toEqual({ status: 403, error: "You can't change this bot." });
    expect(await r.call("GET", "/api/other")).toMatchObject({ out: PASS });
  });
});

describe("starts that are not schedules", () => {
  it("a member cannot change steps that an admin's webhook runs", async () => {
    const r = rig({ levels: { pub: "chat" } });
    r.add("wf-1", "pub");
    r.add("wf-2", "pub");
    r.webhook({ workflowId: "wf-1" });
    const blocked = await r.call("DELETE", "/api/workflows/wf-1", undefined, member);
    expect(blocked).toMatchObject({ status: 403, body: { error: "Only an admin can change an automation that a webhook or app starts." } });
    expect(r.flows.has("wf-1")).toBe(true);
    expect((await r.call("DELETE", "/api/workflows/wf-2", undefined, member)).status).toBe(200);
    expect((await r.call("POST", "/api/workflows/wf-1/switch", { enabled: false }, member)).status).toBe(403);
  });

  it("a member cannot switch a workflow that an admin's webhook uses", async () => {
    const r = rig();
    r.add("wf-1", "pub");
    const hook = r.webhook({ workflowId: "wf-1" });
    const refused = await r.call("POST", "/api/workflows/wf-1/switch", { enabled: false }, member);
    expect(refused).toMatchObject({ status: 403, body: { error: "Only an admin can change an automation that a webhook or app starts." } });
    expect(r.webhooks.list().find((candidate) => candidate.id === hook.id)!.enabled).toBe(true);
    expect((await r.call("POST", "/api/workflows/wf-1/switch", { enabled: false })).status).toBe(200);
  });

  it("a member cannot change a workflow that an admin's app trigger uses", async () => {
    const r = rig();
    r.add("wf-1", "pub");
    r.apps.push({ id: "app-1", name: "Mail", enabled: true, botId: "pub", app: "gmail", workflowId: "wf-1" });
    const refused = await r.call("PATCH", "/api/workflows/wf-1", { name: "Other", steps: [], connections: [] }, member);
    expect(refused).toMatchObject({ status: 403, body: { error: "Only an admin can change an automation that a webhook or app starts." } });
    expect((await r.call("DELETE", "/api/workflows/wf-1", undefined, member)).status).toBe(403);
    expect(r.flows.has("wf-1")).toBe(true);
  });

  it("run again from here refuses an app run whose first bot cannot watch the app", async () => {
    const r = rig({ appRefusal: "Pia can't watch Gmail. Give Pia access to Gmail first." });
    r.add("wf-1", "pub", "pub");
    r.apps.push({ id: "app-1", name: "Mail", enabled: true, botId: "pub", app: "gmail", workflowId: "wf-1" });
    const flow = r.flows.get("wf-1")!;
    r.workflowRuns.set("run-old", {
      runId: "run-old", workflowId: "wf-1", routineId: "app-1", workflowName: flow.name, status: "failed", graph: { steps: flow.steps, connections: flow.connections },
      botIds: ["pub"], startStepId: "s1", start: { kind: "app", id: "app-1" }, threads: {}, createdAt: 1, updatedAt: 2,
      stepRuns: [{ stepId: "s1", status: "done" }, { stepId: "s2", status: "failed" }],
    });
    const refused = await r.call("POST", "/api/workflow-runs/run-old/steps/s2/run-again");
    expect(refused).toMatchObject({ status: 403, body: { error: "Pia can't watch Gmail. Give Pia access to Gmail first." } });
    expect(r.again).toEqual([]);
  });

  it("a member with access can switch and a member without access cannot", async () => {
    const r = rig();
    r.add("wf-1", "pub");
    r.routine({ workflowId: "wf-1" });
    expect((await r.call("POST", "/api/workflows/wf-1/switch", { enabled: false }, member)).status).toBe(200);
    const low = rig({ levels: { pub: "view" } });
    low.add("wf-1", "pub");
    low.routine({ workflowId: "wf-1" });
    expect((await low.call("POST", "/api/workflows/wf-1/switch", { enabled: false }, member)).status).toBe(403);
    const plain = low.webhook({ name: "Plain" });
    expect((await low.call("POST", "/api/workflows/from-start", { kind: "webhook", id: plain.id }, member)).status).toBe(403);
  });

  it("a refused switch changes no start", async () => {
    const r = rig({ appRefusal: "Pia can't watch Gmail. Give Pia access to Gmail first." });
    r.add("wf-1", "pub");
    const routine = r.routine({ workflowId: "wf-1" });
    r.routines.update(routine.id, { enabled: false });
    r.apps.push({ id: "app-1", name: "Mail", enabled: false, botId: "pub", app: "gmail", workflowId: "wf-1" });
    const refused = await r.call("POST", "/api/workflows/wf-1/switch", { enabled: true });
    expect(refused).toMatchObject({ status: 409, body: { error: "Pia can't watch Gmail. Give Pia access to Gmail first." } });
    expect(r.routines.listRoutines()[0]!.enabled).toBe(false);
    expect(r.apps[0]!.enabled).toBe(false);
  });

  it("run again from here works for a webhook run", async () => {
    const r = rig();
    r.add("wf-1", "pub", "pub");
    const hook = r.webhook({ workflowId: "wf-1" });
    const flow = r.flows.get("wf-1")!;
    const old: WorkflowRun = {
      runId: "run-old", workflowId: "wf-1", routineId: hook.id, workflowName: flow.name, status: "failed", graph: { steps: flow.steps, connections: flow.connections },
      botIds: ["pub"], startStepId: "s1", start: { kind: "webhook", id: hook.id }, threads: {}, createdAt: 1, updatedAt: 2,
      stepRuns: [{ stepId: "s1", status: "done" }, { stepId: "s2", status: "failed" }],
    };
    r.workflowRuns.set("run-old", old);
    const path = "/api/workflow-runs/run-old/steps/s2/run-again";
    expect(await r.call("POST", path)).toMatchObject({ status: 201, body: { run: { id: "run-new" } } });
    expect(r.again).toEqual([`run-old s2 ${hook.id}`]);
    r.webhooks.update(hook.id, { enabled: false });
    expect(await r.call("POST", path)).toMatchObject({ status: 409, body: { error: "This automation's start is off. Turn it on first." } });
    r.webhooks.remove(hook.id);
    expect(await r.call("POST", path)).toMatchObject({ status: 409, body: { error: "The automation that started this run is gone." } });
  });
});
