import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { RoutineRunTrigger } from "../../shared/routines.ts";
import type { Workflow, WorkflowFrame, WorkflowInput, WorkflowRun } from "../../shared/workflows.ts";
import type { AutomationReports } from "../automation-reports.ts";
import type { HostTurnResult } from "../coordinator.ts";
import type { WorkflowRoutineOptions } from "../routine-dispatch.ts";
import { BUSY_CODES } from "../routine-recovery.ts";
import { askOf, waitingFor } from "../routine-waits.ts";
import type { Routine, RoutineManager, RoutineManagerOptions, RoutineRun, RoutineRunOn } from "../routines.ts";
import type { Store } from "../store.ts";
import { createWorkflowRunner, type StepResult, type StepTurn } from "../workflows/runner.ts";
import { workflowCopy, type WorkflowCopyLookup } from "../workflows/routine-link.ts";
import { openWorkflowStore } from "../workflows/store.ts";
import { runnableProblem } from "../workflows/validate.ts";

const MAX_TIMER_MS = 2 ** 31 - 1;

export interface WorkflowTurnOptions {
  threadId: string;
  runOn: RoutineRunOn;
  automationSource: RoutineRunTrigger;
  automationRunId: string;
  continuesRun?: boolean;
  onSettled: (outcome: HostTurnResult) => void;
  onDispatchError: (message: string) => void;
}

export interface WorkflowHostDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "patchTask">;
  routines(): Pick<RoutineManager, "listRoutines" | "listRuns" | "runNow" | "cancelRun" | "update" | "workflowRunState"> | null;
  routineHooks(): Pick<RoutineManagerOptions, "createTask" | "interruptTurn"> | null;
  botState(botId: string): "ready" | "busy" | "missing";
  startTurn(botId: string, text: string, opts: WorkflowTurnOptions): Promise<unknown>;
  reports: Pick<AutomationReports, "postStep">;
  /** True once the app is closing: no new step turn starts. */
  shuttingDown?(): boolean;
  /** True while routines.json cannot be read: a run is not recovered then, because its routine is not there to ask. */
  routinesUnreadable?(): boolean;
  emit(frame: WorkflowFrame): void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface WorkflowHost {
  list(): Workflow[];
  get(id: string): Workflow | null;
  /** `creator` is kept apart from the workflow, so no frame or answer carries it. */
  create(input: WorkflowInput, creator?: string): Workflow;
  /** Who created the workflow; undefined for one saved before this was kept. */
  creator(id: string): string | undefined;
  update(id: string, input: WorkflowInput): Workflow | null;
  remove(id: string): boolean;
  runs(workflowId: string, limit: number): WorkflowRun[];
  run(runId: string): WorkflowRun | null;
  /** Starts the routine again at a failed step. Throws, after it has cancelled the new run, when the run cannot be prepared. */
  runAgain(runId: string, stepId: string, routine: Routine, workflow: Workflow): RoutineRun | null;
  copyFor: WorkflowCopyLookup;
  start: NonNullable<WorkflowRoutineOptions["startWorkflow"]>;
  routineRunChanged(run: RoutineRun): void;
  runtimeEvent(event: RuntimeEvent): void;
  recover(): void;
  close(): void;
}

function stepResult(outcome: HostTurnResult): StepResult {
  if (outcome.cards || outcome.approvalAsk) return { ok: false, needsPerson: true, error: outcome.text };
  if (!outcome.ok || outcome.stalled) return { ok: false, error: outcome.failure?.text || outcome.text || "The turn failed" };
  return { ok: true, text: outcome.text };
}

export function createWorkflowHost(deps: WorkflowHostDeps): WorkflowHost {
  const now = deps.now ?? Date.now;
  const store = openWorkflowStore(deps.dataDir);
  const botName = (botId: string): string | undefined => deps.store.bot(botId)?.name;

  const setTimer = (at: number, fire: () => void): (() => void) => {
    let handle: ReturnType<typeof setTimeout>;
    const arm = () => {
      const delay = Math.max(0, at - now());
      handle = setTimeout(delay > MAX_TIMER_MS ? arm : fire, Math.min(delay, MAX_TIMER_MS));
      handle.unref();
    };
    arm();
    return () => clearTimeout(handle);
  };

  const threadFor = (run: RoutineRun, botId: string): string | null => {
    if (botId === run.botId && run.threadId) return run.threadId;
    const hooks = deps.routineHooks();
    if (!hooks) return null;
    const suffix = ` · ${new Date(run.startedAt ?? now()).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    const task = hooks.createTask(botId, `${run.routineName.slice(0, 80 - suffix.length).trimEnd()}${suffix}`, run);
    if (!task) return null;
    deps.store.patchTask(botId, task.threadId, { routineRunId: run.id, unread: false });
    return task.threadId;
  };

  const startTurn = (turn: StepTurn) => {
    const failed = (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      const message = error instanceof Error ? error.message : String(error);
      turn.settle(typeof code === "string" && BUSY_CODES.has(code) ? { ok: false, busy: true, error: message } : { ok: false, error: message });
    };
    if (deps.shuttingDown?.()) return;
    try {
      void Promise.resolve(deps.startTurn(turn.botId, turn.prompt, {
        threadId: turn.threadId,
        runOn: turn.run.runOn,
        automationSource: turn.run.triggerSource ?? (turn.run.manual ? "manual" : "schedule"),
        automationRunId: turn.run.id,
        continuesRun: turn.continuesRun,
        onSettled: (outcome) => turn.settle(stepResult(outcome)),
        onDispatchError: (message) => turn.settle({ ok: false, error: message }),
      })).catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  const runner = createWorkflowRunner({
    now,
    setTimer,
    store,
    botName,
    botState: deps.botState,
    threadFor,
    startTurn,
    stopTurn: async (botId, threadId) => { await deps.routineHooks()?.interruptTurn?.(botId, threadId); },
    post: (run, stepId, text, onWritten) => deps.reports.postStep(run, stepId, text, () => onWritten()),
    runState: (runId, state, detail) => deps.routines()?.workflowRunState(runId, state, detail) ?? null,
    routineRun: (runId) => deps.routines()?.listRuns().find((run) => run.id === runId) ?? null,
    routines: () => deps.routines()?.listRoutines() ?? [],
    runs: () => deps.routines()?.listRuns() ?? [],
    emit: deps.emit,
  });

  const relink = (workflowId: string, patch: { workflowId: null; enabled: false } | { rewriteWorkflow: true }, stale?: (routine: Routine) => boolean) => {
    const routines = deps.routines();
    for (const routine of routines?.listRoutines().filter((candidate) => candidate.workflowId === workflowId && (stale?.(candidate) ?? true)) ?? []) {
      try {
        routines?.update(routine.id, patch);
      } catch (error) {
        deps.log?.(`workflows: could not update routine ${routine.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const copyChanged = (workflow: Workflow) => {
    const copy = workflowCopy(workflow, botName);
    return (routine: Routine) => routine.prompt !== copy.prompt || routine.botId !== copy.botId || routine.workflowBotIds?.join("\n") !== copy.botIds.join("\n");
  };

  return {
    list: () => store.listWorkflows(),
    get: (id) => store.workflow(id),
    creator: (id) => store.creator(id),
    create(input, creator) {
      const at = now();
      const workflow: Workflow = { id: randomUUID(), name: input.name, steps: input.steps, connections: input.connections, createdAt: at, updatedAt: at };
      store.putWorkflow(workflow);
      if (creator) store.putCreator(workflow.id, creator);
      deps.emit({ kind: "workflow", workflow });
      return workflow;
    },
    update(id, input) {
      const existing = store.workflow(id);
      if (!existing) return null;
      const workflow: Workflow = { ...existing, name: input.name, steps: input.steps, connections: input.connections, updatedAt: Math.max(now(), existing.updatedAt + 1) };
      store.putWorkflow(workflow);
      deps.emit({ kind: "workflow", workflow });
      relink(id, { rewriteWorkflow: true }, copyChanged(workflow));
      return workflow;
    },
    remove(id) {
      if (!store.workflow(id)) return false;
      relink(id, { workflowId: null, enabled: false });
      store.deleteWorkflow(id);
      deps.emit({ kind: "workflow.deleted", workflowId: id });
      return true;
    },
    runs: (workflowId, limit) => store.runsOf(workflowId, limit),
    run: (runId) => store.run(runId),
    runAgain(runId, stepId, routine, workflow) {
      const old = store.run(runId);
      const routines = deps.routines();
      if (!old || !routines) return null;
      const started = routines.runNow(routine.id);
      if (!started) return null;
      try {
        runner.prepareFrom(started, old, stepId, workflow);
      } catch (error) {
        void routines.cancelRun(started.id).catch(() => {});
        throw error;
      }
      return started;
    },
    copyFor(workflowId) {
      const workflow = store.workflow(workflowId);
      return workflow ? runnableProblem(workflow, { botName }) ?? workflowCopy(workflow, botName) : null;
    },
    start: (run, threadId, onDispatchError) => runner.start(run, threadId, onDispatchError),
    routineRunChanged: (run) => runner.routineRunChanged(run),
    runtimeEvent(event) {
      if (event.type === "request.opened") runner.asked(event.threadId, waitingFor(askOf(event, now())) ?? "");
      else if (event.type === "request.resolved") runner.asked(event.threadId, null);
    },
    recover: () => { if (!deps.routinesUnreadable?.()) runner.recover(); },
    close() {
      runner.close();
      store.close();
    },
  };
}
