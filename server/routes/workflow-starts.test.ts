import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import type { Workflow, WorkflowInput } from "../../shared/workflows.ts";
import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import { createWorkflowStarts } from "../host/workflow-starts.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import { RoutineManager } from "../routines.ts";
import { WebhookManager } from "../webhooks.ts";
import { workflowCopy } from "../workflows/routine-link.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createWorkflowRoutes, startLinkRefusal } from "./workflows.ts";

const BOB: Viewer = { kind: "member", email: "bob@example.test" };
const bots = [
  { id: "pub", threadId: "t-pub" },
  { id: "hr", threadId: "t-hr", visibility: { people: ["ada@example.test"] } },
];
const names: Record<string, string> = { pub: "Pia", hr: "Hal" };
const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const position = { x: 0, y: 0 };
const botStep = (id: string, botId: string) => ({ id, kind: "bot" as const, botId, instruction: "Do the work.", position });

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rig(over: { levels?: Record<string, BotAccessLevel> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wfs-"));
  dirs.push(dir);
  const flows = new Map<string, Workflow>();
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
  } as unknown as WorkflowHost;
  const routines = new RoutineManager({
    file: join(dir, "routines.json"), botState: () => "busy", createTask: () => ({ threadId: "thread" }), startTurn: async () => {}, workflowCopy: lookup,
  });
  closers.push(() => routines.close());
  const webhooks = new WebhookManager({ file: join(dir, "webhooks.json"), botState: () => "ready", enqueue: () => ({ id: "run" }), workflowCopy: lookup });
  const starts = createWorkflowStarts({ routines: () => routines, webhooks: () => webhooks, appTriggers: () => ({ list: () => [], update: async () => null }) });
  const visible = new VisibleSet(bots, [], BOB);
  const botsRefusal = (_auth: RequestAuth, ids: readonly string[], needed: "chat" | "edit") =>
    (ids.some((id) => !atLeast(over.levels?.[id] ?? "edit", needed)) ? "You can't change this bot." : null);
  const deps = {
    visible: () => visible, botName: (id: string) => names[id], workflows: () => host, routines: () => routines, starts: () => starts,
    routineEdits: { writer: () => "me", refusal: () => null, edit: <T>(_auth: RequestAuth, _routines: unknown, change: () => T) => change() },
    botsRefusal, routineNeeds: () => "chat" as const,
  };
  const routes = createWorkflowRoutes(deps);
  async function call(method: string, path: string, body?: unknown) {
    const sent: { status?: number; body?: any } = {};
    const context = {
      req: {} as RouteContext["req"], res: {} as RouteContext["res"], url: new URL(`http://x${path}`), path, method, auth,
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
  return { flows, add, host, routines, webhooks, starts, visible, deps, call, routine, webhook, botsRefusal };
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

  it("refuses a setting that a workflow cannot use, and leaves no workflow behind", async () => {
    const r = rig();
    const routine = r.routine({ modelSelection: { instanceId: "codex", model: "gpt-x" } });
    const refused = await r.call("POST", "/api/workflows/from-start", { kind: "routine", id: routine.id });
    expect(refused).toMatchObject({ status: 409, body: { error: "Each bot in a workflow uses its own model." } });
    expect(r.flows.size).toBe(0);
    expect(r.routines.listRoutines()[0]!.workflowId).toBeUndefined();

    const empty = r.webhook({ name: "Blank", prompt: "  " });
    expect((await r.call("POST", "/api/workflows/from-start", { kind: "webhook", id: empty.id })).body.error).toBe("Write what the bot should do first.");
    expect(r.flows.size).toBe(0);
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
