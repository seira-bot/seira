import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Workflow, WorkflowInput, WorkflowRun } from "../../shared/workflows.ts";
import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import { frameForMember, routineRunVisible, routineVisible, VisibleSet, type StreamSeen, type Viewer } from "../bot-visibility.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import { PlaceLostError } from "../place-lost.ts";
import { PublicError } from "../public-error.ts";
import type { RequestAuth } from "../request-auth.ts";
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestOptionCard, type RoutineRequestStore } from "../routine-requests.ts";
import { RoutineManager, type Routine, type RoutineRun } from "../routines.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createCloudRoutineAuthors, routineFingerprint } from "../cloud-lending.ts";
import { createWorkflowRoutineEdits, type WorkflowRoutineEdits } from "../host/workflow-routine-edits.ts";
import { createWorkflowRoutes, workflowLinkRefusal, workflowTargetHidden } from "./workflows.ts";

const BOB: Viewer = { kind: "member", email: "bob@example.test" };
const bots = [
  { id: "pub", threadId: "t-pub" },
  { id: "hr", threadId: "t-hr", visibility: { people: ["ada@example.test"] } },
];
const names: Record<string, string> = { pub: "Pia", hr: "Hal" };
const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const position = { x: 0, y: 0 };
const botStep = (id: string, botId: string) => ({ id, kind: "bot" as const, botId, instruction: "Do the work.", position });

function workflow(id: string, ...botIds: string[]): Workflow {
  return {
    id, name: `Flow ${id}`, createdAt: 1, updatedAt: 5,
    steps: botIds.map((botId, index) => botStep(`s${index + 1}`, botId)),
    connections: botIds.slice(1).map((_, index) => ({ id: `c${index + 1}`, from: `s${index + 1}`, to: `s${index + 2}` })),
  };
}

function run(runId: string, workflowId: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const flow = workflow(workflowId, "pub", "pub");
  return {
    runId, workflowId, routineId: "r1", workflowName: flow.name, status: "failed", graph: { steps: flow.steps, connections: flow.connections },
    botIds: ["pub"], startStepId: "s1", threads: {}, createdAt: 1, updatedAt: 2,
    stepRuns: [{ stepId: "s1", status: "done" }, { stepId: "s2", status: "failed" }], ...over,
  };
}

function fixture(over: { workflows?: Workflow[]; runs?: WorkflowRun[]; routines?: Array<Partial<Routine>>; viewer?: Viewer; again?: WorkflowHost["runAgain"]; edits?: WorkflowRoutineEdits; rewrite?: (routine: Routine) => void; creators?: Record<string, string>; levels?: Record<string, BotAccessLevel>; own?: string[] } = {}) {
  const flows = new Map((over.workflows ?? [workflow("open", "pub", "pub"), workflow("secret", "pub", "hr")]).map((flow) => [flow.id, flow]));
  const runs = over.runs ?? [run("run-open", "open"), run("run-secret", "secret", { botIds: ["pub", "hr"] })];
  const calls: string[] = [];
  const routines = (over.routines ?? [{ id: "r1", botId: "pub", workflowId: "open" }]) as Routine[];
  const host = {
    list: () => [...flows.values()],
    get: (id: string) => flows.get(id) ?? null,
    creator: (id: string) => over.creators?.[id],
    create: (input: WorkflowInput) => { const made = { ...input, id: "new", createdAt: 9, updatedAt: 9 } as Workflow; flows.set("new", made); return made; },
    update: (id: string, input: WorkflowInput) => { for (const linked of routines) if (linked.workflowId === id) over.rewrite?.(linked); const next = { ...flows.get(id)!, ...input, updatedAt: 10 } as Workflow; flows.set(id, next); return next; },
    remove: (id: string) => { for (const linked of routines) if (linked.workflowId === id) over.rewrite?.(linked); calls.push(`remove ${id}`); return flows.delete(id); },
    runs: (id: string, limit: number) => { calls.push(`runs ${id} ${limit}`); return runs.filter((candidate) => candidate.workflowId === id); },
    run: (id: string) => runs.find((candidate) => candidate.runId === id) ?? null,
    runAgain: over.again ?? ((runId: string, stepId: string) => { calls.push(`again ${runId} ${stepId}`); return { id: "run-new" } as RoutineRun; }),
  } as unknown as WorkflowHost;
  const visible = new VisibleSet(bots, [], over.viewer ?? BOB);
  const routes = createWorkflowRoutes({ visible: () => visible, botName: (id) => names[id], workflows: () => host, routines: () => ({ listRoutines: () => routines, update: () => null }), starts: () => null,
    routineEdits: over.edits ?? { writer: () => "me", refusal: () => null, edit: (_auth, _routines, change) => change() },
    botsRefusal: (_auth, ids, needed) => (ids.some((id) => !atLeast(over.levels?.[id] ?? "edit", needed)) ? "You can't change this bot." : null),
    routineNeeds: (_auth, id) => (id === undefined || over.own?.includes(id) ? "chat" : "edit") });
  async function call(method: string, path: string, body?: unknown) {
    const sent: { status?: number; body?: any } = {};
    const context = {
      req: {} as RouteContext["req"], res: {} as RouteContext["res"], url: new URL(`http://x${path}`), path: path.split("?")[0]!, method, auth,
      json: ((_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as unknown as RouteContext["json"],
      readBody: (async () => body) as unknown as RouteContext["readBody"],
    } as RouteContext;
    const out = await routes(context);
    return { out, ...sent };
  }
  return { call, calls, host, visible, routines };
}

const input = (...botIds: string[]) => {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = workflow("x", ...botIds);
  return rest;
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("workflow routes", () => {
  it("passes paths that are not workflows", async () => {
    expect((await fixture().call("GET", "/api/routines")).out).toBe(PASS);
  });

  it("lists only workflows whose every bot the person sees", async () => {
    const listed = await fixture().call("GET", "/api/workflows");
    expect(listed.status).toBe(200);
    expect(listed.body.workflows.map((flow: Workflow) => flow.id)).toEqual(["open"]);
    const all = await fixture({ viewer: { kind: "all" } }).call("GET", "/api/workflows");
    expect(all.body.workflows.map((flow: Workflow) => flow.id)).toEqual(["open", "secret"]);
  });

  it("returns 404 to open, change, delete, list runs and run again for a hidden workflow", async () => {
    const { call, calls } = fixture({ routines: [{ id: "r1", botId: "pub", workflowId: "secret" }] });
    for (const [method, path, body] of [
      ["GET", "/api/workflows/secret"], ["PATCH", "/api/workflows/secret", input("pub")], ["DELETE", "/api/workflows/secret"],
      ["GET", "/api/workflows/secret/runs"], ["GET", "/api/workflow-runs/run-secret"],
      ["POST", "/api/workflow-runs/run-secret/steps/s2/run-again"],
    ] as const) {
      const answer = await call(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(404);
    }
    expect(calls).toEqual([]);
    expect((await call("GET", "/api/workflows/gone")).body).toEqual({ error: "no such workflow" });
  });

  it("returns 404 to run again when the run is open but its workflow became hidden", async () => {
    const { call, calls } = fixture({ workflows: [workflow("open", "pub", "hr")], routines: [{ id: "r1", botId: "pub", workflowId: "open" }] });
    const answer = await call("POST", "/api/workflow-runs/run-open/steps/s2/run-again");
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: "no such workflow" });
    expect(calls).toEqual([]);
  });

  it("answers a save that names a hidden bot as it answers an unknown bot", async () => {
    const { call, calls } = fixture();
    const hidden = await call("POST", "/api/workflows", input("pub", "hr"));
    const unknown = await call("POST", "/api/workflows", input("pub", "gone"));
    expect(hidden.status).toBe(400);
    expect(JSON.stringify(hidden.body).replace(/hr|Hal/g, "x")).toBe(JSON.stringify(unknown.body).replace(/gone/g, "x"));
    expect(JSON.stringify(hidden.body)).not.toContain("Hal");
    expect((await call("PATCH", "/api/workflows/open", input("hr"))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  describe("on a Team Cloud, by what the person may do with a bot", () => {
    it("refuses to change, delete or create a workflow when a bot is below the level", async () => {
      const { call, calls } = fixture({ levels: { pub: "chat" }, routines: [] });
      expect((await call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(403);
      expect((await call("DELETE", "/api/workflows/open")).status).toBe(403);
      expect(calls).toEqual([]);
      const viewOnly = fixture({ levels: { pub: "view" } });
      expect((await viewOnly.call("POST", "/api/workflows", input("pub"))).status).toBe(403);
      expect(viewOnly.calls).toEqual([]);
    });

    it("checks the bots the new graph names, and those of a linked routine", async () => {
      const { call } = fixture({ levels: { pub: "edit", other: "view" }, routines: [{ id: "r1", botId: "other", workflowId: "open" }] });
      expect((await call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(403);
      expect((await call("DELETE", "/api/workflows/open")).status).toBe(403);
    });

    it("lets a person who edits every bot change it", async () => {
      expect((await fixture({ levels: { pub: "edit" } }).call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(200);
    });

    it("a chat-level member cannot change a workflow they did not create, even when only their routine links it", async () => {
      for (const creators of [{}, { open: "someone-else" }] as Array<Record<string, string>>) {
        const { call, calls } = fixture({ levels: { pub: "chat" }, own: ["r1"], creators });
        expect((await call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(403);
        expect((await call("DELETE", "/api/workflows/open")).status).toBe(403);
        expect(calls).toEqual([]);
      }
    });

    it("the creator with chat level can change their own workflow that only their routines link", async () => {
      const mine = fixture({ levels: { pub: "chat" }, own: ["r1"], creators: { open: "me" } });
      expect((await mine.call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(200);
      expect((await mine.call("DELETE", "/api/workflows/open")).status).toBe(200);
      const shared = fixture({ levels: { pub: "chat" }, creators: { open: "me" } });
      expect((await shared.call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(403);
    });

    it("needs chat, not edit, to run a failed step again", async () => {
      const chat = fixture({ levels: { pub: "chat" } });
      expect((await chat.call("POST", "/api/workflow-runs/run-open/steps/s2/run-again")).status).toBe(201);
      const view = fixture({ levels: { pub: "view" } });
      expect((await view.call("POST", "/api/workflow-runs/run-open/steps/s2/run-again")).status).toBe(403);
      expect(view.calls).toEqual([]);
    });
  });

  describe("linking a routine to a workflow", () => {
    const deps = (levels: Record<string, BotAccessLevel>) => ({
      botsRefusal: (_auth: RequestAuth, ids: readonly string[], needed: "chat" | "edit") => (ids.some((id) => !atLeast(levels[id] ?? "edit", needed)) ? "no" : null),
      routineNeeds: (_auth: RequestAuth, id: string | undefined) => (id === undefined ? "chat" as const : "edit" as const),
    });
    it("refuses a link to a workflow whose bots the person may not use", () => {
      const { host } = fixture({ viewer: { kind: "all" } });
      expect(workflowLinkRefusal({ workflowId: "open" }, undefined, auth, host, deps({ pub: "view" }))).toBe("no");
      expect(workflowLinkRefusal({ workflowId: "open" }, undefined, auth, host, deps({ pub: "chat" }))).toBeNull();
      const existing = { id: "r1", workflowId: "open", workflowBotIds: ["pub"] } as Routine;
      expect(workflowLinkRefusal({ workflowId: "secret" }, existing, auth, host, deps({ pub: "chat", hr: "edit" }))).toBe("no");
      expect(workflowLinkRefusal({ name: "x" }, existing, auth, host, deps({ pub: "view" }))).toBeNull();
    });
  });

  it("creates, reads, changes and deletes a visible workflow", async () => {
    const { call } = fixture();
    const created = await call("POST", "/api/workflows", { ...input("pub"), name: "Mine" });
    expect(created.status).toBe(201);
    expect(created.body.workflow).toMatchObject({ id: "new", name: "Mine" });
    expect((await call("GET", "/api/workflows/open")).body.workflow.id).toBe("open");
    const changed = await call("PATCH", "/api/workflows/open", { ...input("pub"), name: "Renamed", ifUpdatedAt: 5 });
    expect(changed).toMatchObject({ status: 200, body: { workflow: { name: "Renamed" } } });
    expect(await call("DELETE", "/api/workflows/open")).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("answers a bad save with the first problem, and a stale save with 409", async () => {
    const { call } = fixture();
    const bad = await call("POST", "/api/workflows", { ...input("pub"), name: "" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "workflow_name" });
    expect(bad.body.problems.length).toBeGreaterThan(0);
    expect((await call("POST", "/api/workflows", "nonsense")).body.code).toBe("workflow_shape");
    const stale = await call("PATCH", "/api/workflows/open", { ...input("pub"), ifUpdatedAt: 4 });
    expect(stale).toMatchObject({ status: 409, body: { code: "workflow_changed" } });
  });

  it("lists runs without their graph and keeps the limit between 1 and 50", async () => {
    const { call, calls } = fixture();
    const listed = await call("GET", "/api/workflows/open/runs");
    expect(listed.status).toBe(200);
    expect(listed.body.runs).toHaveLength(1);
    expect(listed.body.runs[0]).not.toHaveProperty("graph");
    await call("GET", "/api/workflows/open/runs?limit=500");
    await call("GET", "/api/workflows/open/runs?limit=0");
    await call("GET", "/api/workflows/open/runs?limit=7");
    expect(calls).toEqual(["runs open 20", "runs open 50", "runs open 1", "runs open 7"]);
  });

  it("reads a visible run whole and hides a run that used a hidden bot", async () => {
    const { call } = fixture();
    expect((await call("GET", "/api/workflow-runs/run-open")).body.run.graph).toBeDefined();
    expect(await call("GET", "/api/workflow-runs/run-secret")).toMatchObject({ status: 404, body: { error: "no such run" } });
    expect((await call("GET", "/api/workflow-runs/none")).status).toBe(404);
  });

  it("checks run again in order, then starts the run", async () => {
    const again = "/api/workflow-runs/run-open/steps/s2/run-again";
    expect(await fixture().call("POST", again)).toMatchObject({ status: 201, body: { run: { id: "run-new" } } });
    expect(await fixture().call("POST", "/api/workflow-runs/none/steps/s2/run-again")).toMatchObject({ status: 404, body: { error: "no such run" } });
    expect(await fixture({ runs: [run("run-open", "open", { status: "active" })] }).call("POST", again))
      .toMatchObject({ status: 409, body: { error: "This run is still going." } });
    expect(await fixture({ routines: [] }).call("POST", again)).toMatchObject({ status: 404, body: { error: "no such routine" } });
    expect(await fixture({ routines: [{ id: "r1", botId: "hr", workflowId: "open" }] }).call("POST", again))
      .toMatchObject({ status: 404, body: { error: "no such routine" } });
    expect(await fixture({ routines: [{ id: "r1", botId: "pub", workflowId: "other" }] }).call("POST", again))
      .toMatchObject({ status: 409, body: { error: "This routine now runs another workflow." } });
    expect(await fixture().call("POST", "/api/workflow-runs/run-open/steps/s1/run-again"))
      .toMatchObject({ status: 409, body: { error: "Only a failed step can run again." } });
    const gone = run("run-open", "open", { stepRuns: [{ stepId: "s9", status: "failed" }] });
    expect(await fixture({ runs: [gone] }).call("POST", "/api/workflow-runs/run-open/steps/s9/run-again"))
      .toMatchObject({ status: 409, body: { error: "That step is no longer in the workflow." } });
    expect(await fixture({ again: () => null }).call("POST", again)).toMatchObject({ status: 409, body: { error: "The routine can't run now." } });
    expect(await fixture({ again: () => { throw new PlaceLostError(); } }).call("POST", again))
      .toMatchObject({ status: 409, body: { error: expect.stringMatching(/Choose where it runs/) } });
    expect(await fixture({ again: () => { throw new PublicError("That step is no longer in the workflow.", 409); } }).call("POST", again))
      .toMatchObject({ status: 409, body: { error: "That step is no longer in the workflow." } });
    expect(await fixture({ again: () => { throw new PublicError("Wait for the backup to finish.", 423); } }).call("POST", again))
      .toMatchObject({ status: 423, body: { error: "Wait for the backup to finish." } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fixture({ again: () => { throw new Error("EACCES: permission denied, open '/Users/someone/.seira/workflows/runs.json'"); } }).call("POST", again))
      .toMatchObject({ status: 500, body: { error: "The run could not start." } });
    quiet.mockRestore();
  });

  it("refuses to change a workflow that runs a routine the person can't change", async () => {
    const asked: string[] = [];
    const edits: WorkflowRoutineEdits = {
      writer: () => "me",
      refusal: (_auth, routine) => { asked.push(routine.id); return routine.id === "mine-not" ? "This workflow runs a routine you can't change." : null; },
      edit: (_auth, _routines, change) => change(),
    };
    const routines = [{ id: "r1", botId: "pub", workflowId: "open" }, { id: "mine-not", botId: "pub", workflowId: "open" }];
    const { call, calls } = fixture({ routines, edits });
    const patched = await call("PATCH", "/api/workflows/open", input("pub"));
    expect(patched).toMatchObject({ status: 403, body: { error: "This workflow runs a routine you can't change." } });
    const deleted = await call("DELETE", "/api/workflows/open");
    expect(deleted).toMatchObject({ status: 403, body: { error: "This workflow runs a routine you can't change." } });
    expect(asked).toContain("mine-not");
    expect(calls).toEqual([]);
    const free = fixture({ routines: [{ id: "r1", botId: "pub", workflowId: "open" }], edits });
    expect((await free.call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(200);
  });

  it("an allowed workflow change keeps the routine's owner check valid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-authors-"));
    dirs.push(dir);
    const authors = createCloudRoutineAuthors(join(dir, "authors.json"));
    const routine = { id: "r1", botId: "pub", workflowId: "open", prompt: "1. Old copy.", schedule: { type: "daily", time: "09:00" } } as unknown as Routine;
    authors.record("r1", routine);
    expect(authors.authored("r1", routine)).toBe(true);
    let owner = true;
    const edits = createWorkflowRoutineEdits({
      refusal: () => null, writer: () => "p_aaaaaaaaaaaaaaaaaaaaaa", withWriter: (_writer, work) => work(), current: () => routine,
      edited: (_auth, edited, writer) => { if (owner) authors.record(edited.id, edited); else authors.forget(edited.id); authors.wrote(edited.id, writer); },
    });
    const rewrite = (linked: Routine) => { linked.prompt = "1. New copy."; };
    const { call } = fixture({ routines: [routine], edits, rewrite });
    expect(authors.authored("r1", routine)).toBe(true);
    expect((await call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(200);
    expect(routine.prompt).toBe("1. New copy.");
    expect(authors.authored("r1", routine)).toBe(true);
    owner = false;
    rewrite(routine);
    routine.prompt = "1. Newer copy.";
    expect((await call("PATCH", "/api/workflows/open", input("pub"))).status).toBe(200);
    expect(authors.recorded("r1")).toBe(false);
    expect(authors.writer("r1")).toBe("p_aaaaaaaaaaaaaaaaaaaaaa");
  });

  it("changes the owner fingerprint when a workflow link changes, and keeps old fingerprints", () => {
    const plain = { prompt: "Do it.", botId: "pub" };
    expect(routineFingerprint({ ...plain, workflowId: "w" })).not.toBe(routineFingerprint(plain));
    expect(routineFingerprint({ ...plain, workflowId: "w" })).not.toBe(routineFingerprint({ ...plain, workflowId: "v" }));
    expect(routineFingerprint({ ...plain, workflowId: undefined })).toBe(routineFingerprint(plain));
  });

  it("refuses a routine save that links a workflow with a hidden bot", () => {
    const { host, visible } = fixture();
    expect(workflowTargetHidden({ workflowId: "secret" }, visible, host)).toBe("no such workflow");
    expect(workflowTargetHidden({ workflowId: "open" }, visible, host)).toBeNull();
    expect(workflowTargetHidden({ workflowId: "gone" }, visible, host)).toBe("no such workflow");
    expect(workflowTargetHidden({ name: "plain" }, visible, host)).toBeNull();
    expect(workflowTargetHidden({ workflowId: "secret" }, new VisibleSet(bots, [], { kind: "all" }), host)).toBeNull();
    expect(workflowTargetHidden({ workflowId: "secret" }, visible, null)).toBeNull();
  });

  it("hides a routine whose workflow has a hidden bot", () => {
    const { visible } = fixture();
    expect(routineVisible({ botId: "pub", workflowBotIds: ["pub", "hr"] }, visible)).toBe(false);
    expect(routineRunVisible({ botId: "pub", workflowBotIds: ["pub", "hr"] }, visible)).toBe(false);
    expect(routineVisible({ botId: "pub", workflowBotIds: ["pub"] }, visible)).toBe(true);
  });

  it("sends no workflow frame about a hidden bot to a member", () => {
    const { visible } = fixture();
    const ctx = { visible, webhook: () => undefined, freshBot: (id: string) => ({ id, messages: [] }), freshGroup: (id: string) => ({ id, messages: [] }) } as never;
    const seen: StreamSeen = { bots: new Set(), groups: new Set() };
    const secret = workflow("secret", "pub", "hr");
    expect(frameForMember({ kind: "workflow", workflow: secret }, ctx, seen)).toBeUndefined();
    expect(frameForMember({ kind: "workflow.run", run: { runId: "r", botIds: ["pub", "hr"], stepRuns: [] } }, ctx, seen)).toBeUndefined();
    const open = { kind: "workflow", workflow: workflow("open", "pub") };
    expect(frameForMember(open, ctx, seen)).toBe(open);
  });
});

describe("a bot's routine request", () => {
  it("a bot routine request cannot link a workflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-request-"));
    dirs.push(dir);
    const looked: string[] = [];
    const routines = new RoutineManager({
      file: join(dir, "routines.json"), botState: () => "busy", goalState: () => "busy", createTask: () => null, startTurn: async () => {},
      workflowCopy: (id) => { looked.push(id); return { workflowId: id, botIds: ["pub"], botId: "pub", prompt: "1. Do it." } as never; },
    });
    const threads = new Map<string, RoutineRequestMessage[]>();
    const store: RoutineRequestStore = {
      messagesFor: (threadId) => threads.get(threadId) ?? [],
      appendMessage: (threadId, message: { card: RoutineRequestOptionCard }) => {
        const stored = { id: `m${threads.size + 1}`, card: message.card };
        threads.set(threadId, [...(threads.get(threadId) ?? []), stored]);
        return stored;
      },
      patchMessage: (threadId, messageId, patch) => {
        const found = (threads.get(threadId) ?? []).find((candidate) => candidate.id === messageId);
        if (found) found.card = patch.card;
        return found ?? null;
      },
    };
    const service = new RoutineRequestService({ store, routines, now: () => Date.parse("2026-11-20T10:00:00Z"), timeZone: () => "UTC" });
    const routine = { name: "Sneaky", instructions: "Say hello.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] }, workflowId: "secret" };
    let outcome: string;
    try {
      const proposed = await service.propose({ botId: "pub", threadId: "t", proposal: { action: "create", routine } as never });
      outcome = service.resolve({ botId: "pub", threadId: "t", requestId: proposed.requestId, behavior: "allow" }).state;
    } catch {
      outcome = "refused";
    }
    expect(looked).toEqual([]);
    expect(routines.listRoutines().every((candidate) => candidate.workflowId === undefined)).toBe(true);
    expect(["applied", "refused"]).toContain(outcome);
  });
});
