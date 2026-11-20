import type { Workflow, WorkflowInput, WorkflowRun, WorkflowRunUpdate } from "../../shared/workflows.ts";
import { routineVisible, workflowRunVisible, workflowVisible, type VisibleSet } from "../bot-visibility.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import { WORKFLOW_ROUTINE_REFUSAL, type WorkflowRoutineEdits } from "../host/workflow-routine-edits.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Routine, RoutineManager } from "../routines.ts";
import { problemBody, validateWorkflowInput } from "../workflows/validate.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WorkflowRoutesDeps {
  visible(auth: RequestAuth): VisibleSet;
  botName(botId: string): string | undefined;
  workflows(): WorkflowHost | null;
  routines(): Pick<RoutineManager, "listRoutines"> | null;
  routineEdits: WorkflowRoutineEdits;
  /** Why this person may not do this much with these bots (Team Cloud levels); null when they may. */
  botsRefusal(auth: RequestAuth, botIds: readonly string[], needed: "chat" | "edit"): string | null;
  /** What this person needs on the bots of a routine they save: "chat" on their own or a new one, else "edit". */
  routineNeeds(auth: RequestAuth, routineId: string | undefined): "chat" | "edit";
}

const RUNS_DEFAULT = 20;
const RUNS_MAX = 50;

const withoutGraph = ({ graph: _graph, ...update }: WorkflowRun): WorkflowRunUpdate => update;

export function workflowBotIds(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const ids = steps.flatMap((step) => ((step as { kind?: unknown } | null)?.kind === "bot" && typeof (step as { botId?: unknown }).botId === "string" ? [(step as { botId: string }).botId] : []));
  return [...new Set(ids)];
}

/** For the routine save: a person who may not edit the bots of the workflow a routine links to, or the one it links to now, may not link it. */
export function workflowLinkRefusal(body: unknown, existing: Routine | undefined, auth: RequestAuth, workflows: WorkflowHost | null, deps: Pick<WorkflowRoutesDeps, "botsRefusal" | "routineNeeds">): string | null {
  const { workflowId } = body && typeof body === "object" ? body as { workflowId?: unknown } : {};
  const next = typeof workflowId === "string" ? workflows?.get(workflowId) : null;
  const old = existing?.workflowId !== undefined && workflowId !== undefined ? existing.workflowBotIds ?? [] : [];
  const bots = [...old, ...workflowBotIds(next?.steps)];
  return bots.length ? deps.botsRefusal(auth, bots, deps.routineNeeds(auth, existing?.id)) : null;
}

function hiddenBot(steps: unknown, visible: VisibleSet, botName: (botId: string) => string | undefined): boolean {
  if (visible.everything || !Array.isArray(steps)) return false;
  return steps.some((step) => {
    const botId = (step as { kind?: unknown; botId?: unknown } | null)?.kind === "bot" ? (step as { botId?: unknown }).botId : undefined;
    return typeof botId === "string" && botName(botId) !== undefined && !visible.bot(botId);
  });
}

/** For the routine save check: a workflow the person may not see is "no such workflow". */
export function workflowTargetHidden(body: unknown, visible: VisibleSet, workflows: WorkflowHost | null): string | null {
  if (visible.everything || !body || typeof body !== "object") return null;
  const { workflowId } = body as { workflowId?: unknown };
  const workflow = typeof workflowId === "string" ? workflows?.get(workflowId) : null;
  return workflow && !workflowVisible(workflow, visible) ? "no such workflow" : null;
}

export function createWorkflowRoutes(deps: WorkflowRoutesDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const again = /^\/api\/workflow-runs\/([\w-]+)\/steps\/([\w-]+)\/run-again$/.exec(path);
    const runMatch = /^\/api\/workflow-runs\/([\w-]+)$/.exec(path);
    const runsMatch = /^\/api\/workflows\/([\w-]+)\/runs$/.exec(path);
    const oneMatch = /^\/api\/workflows\/([\w-]+)$/.exec(path);
    if (path !== "/api/workflows" && !again && !runMatch && !runsMatch && !oneMatch) return PASS;
    const host = deps.workflows();
    if (!host) return json(res, 503, { error: "Workflows are unavailable." });
    const visible = deps.visible(auth);
    const shown = (id: string): Workflow | null => {
      const workflow = host.get(id);
      return workflow && workflowVisible(workflow, visible) ? workflow : null;
    };

    const linkedTo = (workflowId: string) => deps.routines()?.listRoutines().filter((routine) => routine.workflowId === workflowId) ?? [];
    const refused = (linked: readonly Routine[]) => linked.some((routine) => deps.routineEdits.refusal(auth, routine) !== null);
    const shownName = (id: string) => (visible.bot(id) ? deps.botName(id) : undefined);
    const needsFor = (workflow: Workflow, linked: readonly Routine[]) =>
      host.creator(workflow.id) === deps.routineEdits.writer(auth) && linked.every((routine) => deps.routineNeeds(auth, routine.id) === "chat") ? "chat" : "edit";
    const routineBots = (linked: readonly Routine[]) => linked.flatMap((routine) => [routine.botId, ...(routine.workflowBotIds ?? [])]);
    const save = (body: unknown, current: Workflow | null, write: (input: WorkflowInput) => Workflow | null, status: number, linked: readonly Routine[] = []) => {
      const checked = validateWorkflowInput(body, { botName: shownName });
      if (!checked.ok) return json(res, 400, problemBody(checked.problems));
      if (hiddenBot(checked.value.steps, visible, deps.botName)) return json(res, 404, { error: "no such bot" });
      const needed = current ? needsFor(current, linked) : "chat";
      const short = deps.botsRefusal(auth, [...workflowBotIds(current?.steps), ...workflowBotIds(checked.value.steps), ...routineBots(linked)], needed);
      if (short) return json(res, 403, { error: short });
      if (current && checked.value.ifUpdatedAt !== undefined && checked.value.ifUpdatedAt < current.updatedAt) {
        return json(res, 409, { error: "This workflow was changed somewhere else. Reload it and try again.", code: "workflow_changed" });
      }
      const saved = write(checked.value);
      return saved ? json(res, status, { workflow: saved }) : json(res, 404, { error: "no such workflow" });
    };

    if (path === "/api/workflows") {
      if (method === "GET") return json(res, 200, { workflows: host.list().filter((workflow) => workflowVisible(workflow, visible)) });
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      return save(await readBody(req), null, (input) => host.create(input, deps.routineEdits.writer(auth)), 201);
    }

    if (oneMatch) {
      const workflow = shown(oneMatch[1]!);
      if (!workflow) return json(res, 404, { error: "no such workflow" });
      if (method === "GET") return json(res, 200, { workflow });
      if (method !== "DELETE" && method !== "PATCH") return json(res, 405, { error: "method not allowed" });
      const linked = linkedTo(workflow.id);
      if (refused(linked)) return json(res, 403, { error: WORKFLOW_ROUTINE_REFUSAL });
      if (method === "DELETE") {
        const short = deps.botsRefusal(auth, [...workflowBotIds(workflow.steps), ...routineBots(linked)], needsFor(workflow, linked));
        if (short) return json(res, 403, { error: short });
      }
      if (method === "DELETE") return deps.routineEdits.edit(auth, linked, () => host.remove(workflow.id)) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such workflow" });
      return save(await readBody(req), workflow, (input) => deps.routineEdits.edit(auth, linked, () => host.update(workflow.id, input)), 200, linked);
    }

    if (runsMatch) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const workflow = shown(runsMatch[1]!);
      if (!workflow) return json(res, 404, { error: "no such workflow" });
      const asked = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(asked) ? Math.min(RUNS_MAX, Math.max(1, asked)) : RUNS_DEFAULT;
      return json(res, 200, { runs: host.runs(workflow.id, limit).filter((run) => workflowRunVisible(run, visible)).map(withoutGraph) });
    }

    if (runMatch) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const run = host.run(runMatch[1]!);
      return run && workflowRunVisible(run, visible) ? json(res, 200, { run }) : json(res, 404, { error: "no such run" });
    }

    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const [, runId, stepId] = again!;
    const old = host.run(runId!);
    if (!old || !workflowRunVisible(old, visible)) return json(res, 404, { error: "no such run" });
    if (old.status === "active") return json(res, 409, { error: "This run is still going." });
    const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === old.routineId);
    if (!routine || !routineVisible(routine, visible)) return json(res, 404, { error: "no such routine" });
    if (routine.workflowId !== old.workflowId) return json(res, 409, { error: "This routine now runs another workflow." });
    const workflow = shown(old.workflowId);
    if (!workflow) return json(res, 404, { error: "no such workflow" });
    const short = deps.botsRefusal(auth, [...workflowBotIds(workflow.steps), routine.botId, ...(routine.workflowBotIds ?? [])], "chat");
    if (short) return json(res, 403, { error: short });
    if (old.stepRuns.find((step) => step.stepId === stepId)?.status !== "failed") return json(res, 409, { error: "Only a failed step can run again." });
    const step = workflow.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind === "note") return json(res, 409, { error: "That step is no longer in the workflow." });
    try {
      const started = host.runAgain(old.runId, stepId!, routine, workflow);
      return started ? json(res, 201, { run: started }) : json(res, 409, { error: "The routine can't run now." });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : "The run could not start." });
    }
  };
}
