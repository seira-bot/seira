import { MAX_EVENT_CHARS } from "../app-events.ts";
import {
  WORKFLOW_FRAME_OUTPUT_CHARS,
  WORKFLOW_STEP_OUTPUT_CHARS,
  type Workflow,
  type WorkflowFrame,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStepErrorCode,
  type WorkflowStepRun,
} from "../../shared/workflows.ts";
import { redactSecretsInText } from "../redact.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { RoutineAccess } from "../../shared/routines.ts";
import { continuityCarry } from "../routine-execution.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import { botIdsOf, outgoing, reachable, runnable, startSteps, stepById, stepLabel, stepOrder } from "./graph.ts";
import { WORKFLOW_TIME_WAIT, workflowBotWait } from "./rest-text.ts";
import { botStepPrompt, checkPrompt, parseCheckAnswer } from "./step-prompt.ts";
import type { WorkflowStore } from "./store.ts";
import { runnableProblem } from "./validate.ts";

export type WorkflowRunState = "working" | "waiting" | "completed" | "failed";
export type StepResult = { ok: true; text: string } | { ok: false; error: string; busy?: true; needsPerson?: true };
export interface StepTurn {
  run: RoutineRun;
  stepId: string;
  botId: string;
  threadId: string;
  prompt: string;
  /** Not the run's first turn: a usage cap does not refuse it. */
  continuesRun: boolean;
  /** What this step runs with: its own choice, else the routine's. */
  access?: RoutineAccess;
  modelSelection?: ModelSelection;
  settle(result: StepResult): void;
}
export interface StepThreadOptions {
  /** The step needs a chat of its own: not the run's first one. */
  own: boolean;
  modelSelection?: ModelSelection;
  /** A chat an earlier run used for this same step. Used only while it still fits what the step needs now. */
  reuse?: string;
  access?: RoutineAccess;
}
export interface WorkflowRunnerDeps {
  now(): number;
  /** Returns a cancel function. */
  setTimer(at: number, fire: () => void): () => void;
  store: WorkflowStore;
  botName(botId: string): string | undefined;
  botState(botId: string): "ready" | "busy" | "missing";
  /** The run's chat for this bot: an existing one, or a new chat marked as this run's. */
  threadFor(run: RoutineRun, botId: string, options: StepThreadOptions): string | null;
  /** The run owns this chat: its limits and its access apply there. */
  bindThread?(run: RoutineRun, threadId: string, access?: RoutineAccess): void;
  startTurn(turn: StepTurn): void;
  stopTurn(botId: string, threadId: string, runId: string): Promise<void>;
  post(run: RoutineRun, stepId: string, text: string, onWritten: () => void): void;
  /** The run ended well: its last bot step's chat holds the result the briefing reads. */
  brief?(run: RoutineRun, threadId: string): void;
  runState(runId: string, state: WorkflowRunState, detail?: string): RoutineRun | null;
  routineRun(runId: string): RoutineRun | null;
  routines(): readonly Routine[];
  runs(): readonly RoutineRun[];
  emit(frame: WorkflowFrame): void;
}
export interface WorkflowRunner {
  start(run: RoutineRun, threadId: string, onDispatchError: (message: string) => void): Promise<void>;
  prepareFrom(run: RoutineRun, from: WorkflowRun, stepId: string, workflow: Workflow): void;
  routineRunChanged(run: RoutineRun): void;
  /** A question to the person opened (attention text) or closed (null) in a step's chat. */
  asked(threadId: string, attention: string | null): void;
  recover(): void;
  close(): void;
}

export const BUSY_POLL_MS = 30_000;
export const BUSY_MAX_MS = 180 * 60_000;
export const STEP_ATTEMPTS = 2;

const FINAL_ROUTINE_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "missed"]);
const PENDING_ROUTINE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "waiting"]);

function clipped(text: string, max: number): { text: string; clipped: boolean } {
  return text.length > max ? { text: `${text.slice(0, max - 1).trimEnd()}…`, clipped: true } : { text, clipped: false };
}

export function workflowRunFrame(run: WorkflowRun): Extract<WorkflowFrame, { kind: "workflow.run" }> {
  const { graph: _graph, ...rest } = run;
  return {
    kind: "workflow.run",
    run: {
      ...rest,
      threads: { ...run.threads },
      botIds: [...run.botIds],
      stepRuns: run.stepRuns.map((step) => {
        if (step.output === undefined || step.output.length <= WORKFLOW_FRAME_OUTPUT_CHARS) return { ...step };
        return { ...step, output: step.output.slice(0, WORKFLOW_FRAME_OUTPUT_CHARS), outputClipped: true as const };
      }),
    },
  };
}

interface LiveTurn { stepId: string; botId: string; threadId: string }

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  const { store } = deps;
  const timers = new Map<string, () => void>();
  const live = new Map<string, LiveTurn>();

  const fresh = (runId: string): WorkflowRun | null => {
    const run = store.run(runId);
    return run && run.status === "active" ? run : null;
  };
  const publish = (run: WorkflowRun) => deps.emit(workflowRunFrame(run));
  const patch = (step: WorkflowStepRun, changes: Partial<Record<keyof WorkflowStepRun, unknown>>) => {
    const record = step as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete record[key];
      else record[key] = value;
    }
  };
  const upsert = (run: WorkflowRun, step: WorkflowStepRun) => {
    const index = run.stepRuns.findIndex((candidate) => candidate.stepId === step.stepId);
    if (index >= 0) run.stepRuns[index] = step;
    else run.stepRuns.push(step);
  };
  const saveStep = (run: WorkflowRun, step: WorkflowStepRun) => {
    run.updatedAt = deps.now();
    run.currentStepId = step.stepId;
    upsert(run, step);
    store.putStep(run, step);
    publish(run);
  };
  const saveRun = (run: WorkflowRun) => {
    run.updatedAt = deps.now();
    store.putRun(run);
    publish(run);
  };
  const stepRunOf = (run: WorkflowRun, stepId: string, from: string | undefined): WorkflowStepRun =>
    run.stepRuns.find((candidate) => candidate.stepId === stepId) ?? { stepId, status: "waiting", ...(from === undefined ? {} : { fromStepId: from }) };

  const arm = (runId: string, at: number, fire: () => void) => {
    timers.get(runId)?.();
    timers.set(runId, deps.setTimer(at, () => {
      timers.delete(runId);
      fire();
    }));
  };
  const disarm = (runId: string) => {
    timers.get(runId)?.();
    timers.delete(runId);
  };

  const previousOutput = (run: WorkflowRun, step: WorkflowStepRun): string | undefined => {
    if (step.stepId === run.startStepId && run.input) return run.input.output;
    if (step.stepId === run.startStepId && run.event !== undefined && step.fromStepId === undefined) return run.event;
    return step.fromStepId === undefined ? undefined : run.stepRuns.find((candidate) => candidate.stepId === step.fromStepId)?.output;
  };
  const previousOf = (run: WorkflowRun, step: WorkflowStepRun): { label: string; output: string } | undefined => {
    const output = previousOutput(run, step);
    const from = step.fromStepId === undefined ? undefined : stepById(run.graph, step.fromStepId);
    if (output && from) return { label: stepLabel(from, deps.botName), output };
    return output && step.stepId === run.startStepId && run.event !== undefined && !run.input ? { label: "event", output } : undefined;
  };

  const settleUnreached = (run: WorkflowRun, status: "skipped" | "not_run") => {
    for (const step of stepOrder(run.graph)) {
      const stepRun = run.stepRuns.find((candidate) => candidate.stepId === step.id);
      if (!stepRun) run.stepRuns.push({ stepId: step.id, status });
      else if (status === "not_run" && (stepRun.status === "waiting" || stepRun.status === "running")) patch(stepRun, { status: "not_run" });
    }
  };

  function complete(run: WorkflowRun, output: string) {
    settleUnreached(run, "skipped");
    run.status = "completed";
    saveRun(run);
    disarm(run.runId);
    const done = deps.runState(run.runId, "completed", output);
    if (!done) return;
    if (done.deliver === "brief") {
      const last = run.stepRuns.findLast((candidate) => candidate.threadId !== undefined && stepById(run.graph, candidate.stepId)?.kind === "bot");
      if (last?.threadId) deps.brief?.(done, last.threadId);
    } else if (done.postsResult && !run.graph.steps.some((candidate) => candidate.kind === "post")) {
      deps.post(done, run.stepRuns.findLast((candidate) => candidate.status === "done")?.stepId ?? run.startStepId, output, () => {});
    }
  }

  function fail(run: WorkflowRun, stepRun: WorkflowStepRun, step: WorkflowStep, code: WorkflowStepErrorCode, error: string) {
    const said = redactSecretsInText(error).slice(0, 500);
    patch(stepRun, { status: "failed", error: said, errorCode: code, finishedAt: deps.now(), waitingFor: undefined, resumeAt: undefined, busySince: undefined });
    upsert(run, stepRun);
    run.currentStepId = stepRun.stepId;
    settleUnreached(run, "not_run");
    run.status = "failed";
    live.delete(run.runId);
    saveRun(run);
    disarm(run.runId);
    deps.runState(run.runId, "failed", `${stepLabel(step, deps.botName)} failed: ${said}`);
  }

  function halt(run: WorkflowRun, status: "failed" | "stopped", code: WorkflowStepErrorCode, message: string) {
    const turn = live.get(run.runId);
    live.delete(run.runId);
    disarm(run.runId);
    const said = redactSecretsInText(message).slice(0, 500);
    for (const stepRun of run.stepRuns) {
      if (stepRun.status === "running" || stepRun.status === "waiting") {
        patch(stepRun, { status: "failed", error: said, errorCode: code, finishedAt: deps.now(), waitingFor: undefined, resumeAt: undefined, busySince: undefined });
      }
    }
    settleUnreached(run, "not_run");
    run.status = status;
    saveRun(run);
    if (turn) {
      try {
        void Promise.resolve(deps.stopTurn(turn.botId, turn.threadId, run.runId)).catch(() => {});
      } catch { /* the chat may already be idle */ }
    }
  }

  function again(runId: string, stepId: string, restarted = false) {
    const run = fresh(runId);
    if (!run) return;
    const stepRun = run.stepRuns.find((candidate) => candidate.stepId === stepId);
    enter(run, stepId, stepRun?.fromStepId, restarted);
  }

  function enter(run: WorkflowRun, stepId: string, from: string | undefined, restarted = false) {
    const step = stepById(run.graph, stepId);
    if (!step || !runnable(step)) return complete(run, run.stepRuns.find((candidate) => candidate.stepId === from)?.output ?? "");
    switch (step.kind) {
      case "bot": return runBot(run, step, from, restarted);
      case "check": return runCheck(run, step, from);
      case "wait": return runWait(run, step, from);
      case "post": return runPost(run, step, from);
      case "note": return complete(run, "");
      default: return fail(run, stepRunOf(run, stepId, from), step, "turn_failed", "This step is from a newer version of Seira and can't run here.");
    }
  }

  function next(run: WorkflowRun, step: WorkflowStep, stepRun: WorkflowStepRun) {
    const target = outgoing(run.graph, step.id).find((connection) => {
      const to = stepById(run.graph, connection.to);
      return to !== undefined && runnable(to);
    });
    if (!target) return complete(run, stepRun.output ?? "");
    enter(run, target.to, step.id);
  }

  function waitBusy(run: WorkflowRun, stepRun: WorkflowStepRun, step: WorkflowStep, botId: string) {
    const now = deps.now();
    const since = stepRun.busySince ?? now;
    const name = deps.botName(botId) ?? "The bot";
    if (now - since > BUSY_MAX_MS) return fail(run, stepRun, step, "bot_busy_too_long", `${name} stayed busy for 3 hours.`);
    patch(stepRun, { status: "waiting", waitingFor: "bot", botId, busySince: since, startedAt: stepRun.startedAt ?? now });
    saveStep(run, stepRun);
    deps.runState(run.runId, "waiting", workflowBotWait(name));
    arm(run.runId, now + BUSY_POLL_MS, () => again(run.runId, step.id));
  }

  function launch(
    run: WorkflowRun,
    routineRun: RoutineRun,
    stepRun: WorkflowStepRun,
    botId: string,
    threadId: string,
    prompt: string,
    continuesRun: boolean,
    settings: { access?: RoutineAccess; modelSelection?: ModelSelection },
    onResult: (current: WorkflowRun, result: StepResult) => void,
  ) {
    const turn: LiveTurn = { stepId: stepRun.stepId, botId, threadId };
    live.set(run.runId, turn);
    const settle = (result: StepResult) => {
      if (live.get(run.runId) !== turn) return;
      live.delete(run.runId);
      const current = fresh(run.runId);
      if (current) onResult(current, result);
    };
    try {
      deps.startTurn({ run: routineRun, stepId: stepRun.stepId, botId, threadId, prompt, continuesRun, ...(settings.access ? { access: settings.access } : {}), ...(settings.modelSelection ? { modelSelection: settings.modelSelection } : {}), settle });
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const holdsTurn = (stepRun: WorkflowStepRun | undefined): boolean =>
    stepRun !== undefined && (stepRun.status === "running" || (stepRun.status === "waiting" && stepRun.waitingFor === "person"));

  const previousStepThread = (run: WorkflowRun, stepId: string): string | undefined => {
    for (const earlier of store.runsOf(run.workflowId, 50)) {
      if (earlier.runId === run.runId || earlier.routineId !== run.routineId) continue;
      const thread = earlier.stepRuns.find((candidate) => candidate.stepId === stepId)?.threadId;
      if (thread) return thread;
    }
    return undefined;
  };

  /** The bot starts: its chat, its attempt count and the run's own state, saved before the turn begins. */
  function beginTurn(run: WorkflowRun, stepRun: WorkflowStepRun, step: WorkflowStep, botId: string, chatOf: Extract<WorkflowStep, { kind: "bot" }> | undefined): { routineRun: RoutineRun; threadId: string; access?: RoutineAccess; modelSelection?: ModelSelection } | null {
    const routineRun = deps.routineRun(run.runId);
    if (!routineRun) {
      halt(run, "stopped", "run_stopped", "The run is gone.");
      return null;
    }
    const routine = deps.routines().find((candidate) => candidate.id === routineRun.routineId);
    const modelSelection = chatOf?.modelSelection ?? routine?.modelSelection;
    const access = chatOf?.access ?? routineRun.access;
    const own = chatOf?.modelSelection !== undefined;
    const key = chatOf && (own || routineRun.sameConversation === true) ? `${botId}#${chatOf.id}` : botId;
    const startsHere = chatOf !== undefined && chatOf.id === run.startStepId && botId === routineRun.botId && !own;
    const known = run.threads[key] ?? (startsHere ? routineRun.threadId : undefined);
    const reuse = known === undefined && chatOf && routineRun.sameConversation ? previousStepThread(run, chatOf.id) : undefined;
    const threadId = known ?? deps.threadFor(routineRun, botId, { own: key !== botId, ...(modelSelection ? { modelSelection } : {}), ...(reuse ? { reuse } : {}), ...(access ? { access } : {}) });
    if (!threadId) {
      fail(run, stepRun, step, "turn_failed", `Could not open a chat for ${deps.botName(botId) ?? "the bot"}.`);
      return null;
    }
    const newThread = run.threads[key] !== threadId;
    run.threads[key] = threadId;
    deps.bindThread?.(routineRun, threadId, access);
    patch(stepRun, {
      status: "running", botId, threadId, attempts: (stepRun.attempts ?? 0) + 1, startedAt: stepRun.startedAt ?? deps.now(),
      waitingFor: undefined, resumeAt: undefined, error: undefined, errorCode: undefined, finishedAt: undefined,
    });
    if (newThread) {
      upsert(run, stepRun);
      run.currentStepId = stepRun.stepId;
      saveRun(run);
    } else saveStep(run, stepRun);
    deps.runState(run.runId, "working");
    return { routineRun, threadId, ...(access ? { access } : {}), ...(modelSelection ? { modelSelection } : {}) };
  }

  const isFirstTurn = (run: WorkflowRun, stepRun: WorkflowStepRun): boolean =>
    !run.stepRuns.some((candidate) => candidate.stepId !== stepRun.stepId && !candidate.carried && (candidate.attempts ?? 0) > 0);

  function runBot(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "bot" }>, from: string | undefined, restarted: boolean) {
    const stepRun = stepRunOf(run, step.id, from);
    const name = deps.botName(step.botId) ?? "The bot";
    const state = deps.botState(step.botId);
    if (state === "missing") return fail(run, stepRun, step, "bot_missing", `${name} is no longer available.`);
    if (state === "busy") return waitBusy(run, stepRun, step, step.botId);
    const first = isFirstTurn(run, stepRun);
    const began = beginTurn(run, stepRun, step, step.botId, step);
    if (!began) return;
    const carry = first ? continuityCarry(began.routineRun, deps.routines(), deps.runs()) : null;
    const previous = previousOf(run, stepRun);
    const prompt = botStepPrompt({ run: began.routineRun, instruction: step.instruction, first, carry, ...(previous ? { previous } : {}), restarted });
    launch(run, began.routineRun, stepRun, step.botId, began.threadId, prompt, !first || (stepRun.attempts ?? 0) > 1, began, (current, result) => {
      const currentStep = stepRunOf(current, step.id, from);
      if (!holdsTurn(currentStep)) return;
      if (result.ok) {
        const output = clipped(redactSecretsInText(result.text).trim(), WORKFLOW_STEP_OUTPUT_CHARS);
        patch(currentStep, { status: "done", output: output.text, outputClipped: output.clipped ? true : undefined, finishedAt: deps.now(), waitingFor: undefined, busySince: undefined });
        saveStep(current, currentStep);
        return next(current, step, currentStep);
      }
      if (result.busy) {
        patch(currentStep, { attempts: Math.max(0, (currentStep.attempts ?? 1) - 1) });
        return waitBusy(current, currentStep, step, step.botId);
      }
      if (result.needsPerson) return fail(current, currentStep, step, "needs_person", `${name} asked you a question. Answer it in the chat, then run again from here.`);
      return fail(current, currentStep, step, "turn_failed", result.error);
    });
  }

  const botBefore = (run: WorkflowRun, stepRun: WorkflowStepRun): Extract<WorkflowStep, { kind: "bot" }> | undefined => {
    const seen = new Set<string>();
    let id = stepRun.fromStepId;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const step = stepById(run.graph, id);
      if (step?.kind === "bot") return step;
      id = run.stepRuns.find((candidate) => candidate.stepId === id)?.fromStepId;
    }
    return undefined;
  };

  function runCheck(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "check" }>, from: string | undefined) {
    const stepRun = stepRunOf(run, step.id, from);
    const before = botBefore(run, stepRun);
    const botId = before?.botId;
    if (botId === undefined) return fail(run, stepRun, step, "bot_missing", "AI check: no bot step comes before it.");
    const name = deps.botName(botId) ?? "The bot";
    const state = deps.botState(botId);
    if (state === "missing") return fail(run, stepRun, step, "bot_missing", `${name} is no longer available.`);
    if (state === "busy") return waitBusy(run, stepRun, step, botId);
    const began = beginTurn(run, stepRun, step, botId, before);
    if (!began) return;
    const input = previousOutput(run, stepRun) ?? "";
    launch(run, began.routineRun, stepRun, botId, began.threadId, checkPrompt(run.workflowName, step.question, input), true, began, (current, result) => {
      const currentStep = stepRunOf(current, step.id, from);
      if (!holdsTurn(currentStep)) return;
      if (!result.ok) {
        if (result.busy) {
          patch(currentStep, { attempts: Math.max(0, (currentStep.attempts ?? 1) - 1) });
          return waitBusy(current, currentStep, step, botId);
        }
        if (result.needsPerson) return fail(current, currentStep, step, "needs_person", `${name} asked you a question. Answer it in the chat, then run again from here.`);
        return fail(current, currentStep, step, "turn_failed", result.error);
      }
      const answer = parseCheckAnswer(result.text);
      if (!answer) return fail(current, currentStep, step, "check_unclear", `The answer was not a clear yes or no: “${result.text.trim().slice(0, 40)}”`);
      const taken = outgoing(current.graph, step.id).find((connection) => connection.branch === answer);
      const other = outgoing(current.graph, step.id).find((connection) => connection.branch === (answer === "yes" ? "no" : "yes"));
      patch(currentStep, { status: "done", answer, output: input, finishedAt: deps.now(), waitingFor: undefined, busySince: undefined });
      upsert(current, currentStep);
      current.currentStepId = step.id;
      const kept = reachable(current.graph, taken?.to);
      for (const id of reachable(current.graph, other?.to)) {
        const skipped = stepById(current.graph, id);
        if (kept.has(id) || !skipped || !runnable(skipped) || current.stepRuns.some((candidate) => candidate.stepId === id)) continue;
        current.stepRuns.push({ stepId: id, status: "skipped" });
      }
      if (!taken) return complete(current, input);
      saveRun(current);
      enter(current, taken.to, step.id);
    });
  }

  function runWait(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "wait" }>, from: string | undefined) {
    const stepRun = stepRunOf(run, step.id, from);
    const now = deps.now();
    const resumeAt = stepRun.resumeAt ?? now + step.minutes * 60_000;
    patch(stepRun, { status: "waiting", waitingFor: "time", resumeAt, startedAt: stepRun.startedAt ?? now, output: previousOutput(run, stepRun) ?? "" });
    saveStep(run, stepRun);
    deps.runState(run.runId, "waiting", WORKFLOW_TIME_WAIT);
    arm(run.runId, resumeAt, () => resumeWait(run.runId, step.id));
  }

  function resumeWait(runId: string, stepId: string) {
    const run = fresh(runId);
    const step = run && stepById(run.graph, stepId);
    const stepRun = run?.stepRuns.find((candidate) => candidate.stepId === stepId);
    if (!run || !step || !stepRun || stepRun.status !== "waiting" || stepRun.waitingFor !== "time") return;
    patch(stepRun, { status: "done", waitingFor: undefined, finishedAt: deps.now() });
    saveStep(run, stepRun);
    deps.runState(runId, "working");
    next(run, step, stepRun);
  }

  function runPost(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "post" }>, from: string | undefined) {
    const stepRun = stepRunOf(run, step.id, from);
    const routineRun = deps.routineRun(run.runId);
    if (!routineRun) return halt(run, "stopped", "run_stopped", "The run is gone.");
    const input = previousOutput(run, stepRun) ?? "";
    patch(stepRun, { status: "running", startedAt: stepRun.startedAt ?? deps.now(), waitingFor: undefined, output: input });
    saveStep(run, stepRun);
    deps.runState(run.runId, "working");
    deps.post(routineRun, step.id, input, () => {
      const current = fresh(run.runId);
      const currentStep = current?.stepRuns.find((candidate) => candidate.stepId === step.id);
      if (!current || !currentStep || currentStep.status !== "running") return;
      patch(currentStep, { status: "done", finishedAt: deps.now() });
      saveStep(current, currentStep);
      next(current, step, currentStep);
    });
  }

  function resume(run: WorkflowRun) {
    const stepRun = run.currentStepId === undefined ? undefined : run.stepRuns.find((candidate) => candidate.stepId === run.currentStepId);
    const step = stepRun && stepById(run.graph, stepRun.stepId);
    if (!stepRun || !step) return enter(run, run.startStepId, run.input?.fromStepId);
    if (stepRun.status === "done") return next(run, step, stepRun);
    if (stepRun.status === "waiting" && step.kind === "wait" && stepRun.resumeAt !== undefined) {
      deps.runState(run.runId, "waiting", WORKFLOW_TIME_WAIT);
      return arm(run.runId, Math.max(stepRun.resumeAt, deps.now()), () => resumeWait(run.runId, step.id));
    }
    if (stepRun.status === "waiting" && stepRun.waitingFor === "bot") {
      deps.runState(run.runId, "waiting", workflowBotWait(deps.botName(stepRun.botId ?? "") ?? "the bot"));
      return arm(run.runId, deps.now(), () => again(run.runId, step.id));
    }
    if (stepRun.status === "running" && step.kind === "post") return enter(run, step.id, stepRun.fromStepId);
    if (holdsTurn(stepRun)) {
      patch(stepRun, { busySince: undefined });
      if ((stepRun.attempts ?? 0) < STEP_ATTEMPTS) return enter(run, step.id, stepRun.fromStepId, true);
      return fail(run, stepRun, step, "restart_cut", "Seira restarted while this step was running.");
    }
    halt(run, "failed", "turn_failed", stepRun.error ?? "The step did not finish.");
  }

  return {
    async start(routineRun, threadId, onDispatchError) {
      const existing = store.run(routineRun.id);
      if (existing) {
        if (existing.status !== "active") return onDispatchError("This workflow run already ended.");
        if (existing.threads[routineRun.botId] === undefined) {
          existing.threads[routineRun.botId] = threadId;
          saveRun(existing);
        }
        resume(existing);
        return;
      }
      const workflow = routineRun.workflowId === undefined ? null : store.workflow(routineRun.workflowId);
      if (!workflow) return onDispatchError("This routine's workflow is gone");
      const problem = runnableProblem(workflow, { botName: deps.botName });
      if (problem) return onDispatchError(problem.message);
      const graph = structuredClone({ steps: workflow.steps, connections: workflow.connections });
      const now = deps.now();
      const fromEvent = routineRun.triggerSource === "webhook" && routineRun.webhookId !== undefined;
      const checkItems = routineRun.checkKey !== undefined && !fromEvent ? routineRun.prompt : undefined;
      const run: WorkflowRun = {
        runId: routineRun.id, workflowId: workflow.id, routineId: routineRun.routineId, workflowName: workflow.name, status: "active", graph,
        start: fromEvent
          ? { kind: routineRun.eventSource === "app" ? "app" : "webhook", id: routineRun.webhookId! }
          : { kind: routineRun.manual ? "manual" : "schedule", id: routineRun.routineId },
        ...(fromEvent && routineRun.prompt ? { event: routineRun.prompt.slice(0, MAX_EVENT_CHARS) } : {}),
        ...(checkItems ? { event: checkItems.slice(0, MAX_EVENT_CHARS) } : {}),
        botIds: botIdsOf(graph), startStepId: startSteps(graph)[0]!.id, threads: { [routineRun.botId]: threadId }, stepRuns: [], createdAt: now, updatedAt: now,
      };
      saveRun(run);
      enter(run, run.startStepId, undefined);
    },

    prepareFrom(routineRun, from, stepId, workflow) {
      const graph = structuredClone({ steps: workflow.steps, connections: workflow.connections });
      const start = stepById(graph, stepId);
      if (!start || !runnable(start)) throw new Error("That step is no longer in the workflow.");
      const old = from.stepRuns.find((candidate) => candidate.stepId === stepId);
      const giver = old?.fromStepId === undefined ? undefined : from.stepRuns.find((candidate) => candidate.stepId === old.fromStepId);
      const carried = from.stepRuns
        .filter((candidate) => (candidate.status === "done" || candidate.status === "skipped") && candidate.stepId !== stepId && stepById(graph, candidate.stepId) !== undefined)
        .map((candidate): WorkflowStepRun => ({ ...candidate, carried: true }));
      const now = deps.now();
      const run: WorkflowRun = {
        runId: routineRun.id, workflowId: workflow.id, routineId: routineRun.routineId, workflowName: workflow.name, status: "active", graph,
        botIds: botIdsOf(graph), startStepId: stepId, fromRunId: from.runId,
        ...(from.start === undefined ? {} : { start: from.start }),
        ...(from.event !== undefined && stepId === from.startStepId ? { event: from.event } : {}),
        ...(old?.fromStepId === undefined ? {} : { input: { fromStepId: old.fromStepId, output: giver?.output ?? "" } }),
        threads: {}, stepRuns: carried, createdAt: now, updatedAt: now,
      };
      store.putRun(run);
      publish(run);
    },

    routineRunChanged(routineRun) {
      if (routineRun.workflowId === undefined || PENDING_ROUTINE_STATUSES.has(routineRun.status)) return;
      const run = fresh(routineRun.id);
      if (!run) return;
      const limit = routineRun.errorCode === "routines.server.overLimit";
      halt(run, routineRun.status === "failed" ? "failed" : "stopped", limit ? "run_limit" : "run_stopped", routineRun.error ?? "The run was stopped.");
    },

    asked(threadId, attention) {
      for (const [runId, turn] of live) {
        if (turn.threadId !== threadId) continue;
        const run = fresh(runId);
        const stepRun = run?.stepRuns.find((candidate) => candidate.stepId === turn.stepId);
        if (!run || !stepRun) return;
        if (attention !== null && stepRun.status === "running") {
          patch(stepRun, { status: "waiting", waitingFor: "person", busySince: undefined });
          saveStep(run, stepRun);
          deps.runState(runId, "waiting", redactSecretsInText(attention).trim() || "Waiting for your answer");
        } else if (attention === null && stepRun.status === "waiting" && stepRun.waitingFor === "person") {
          patch(stepRun, { status: "running", waitingFor: undefined });
          saveStep(run, stepRun);
          deps.runState(runId, "working");
        }
        return;
      }
    },

    recover() {
      for (const row of store.activeRuns()) {
        if (live.has(row.runId) || timers.has(row.runId)) continue;
        const routineRun = deps.routineRun(row.runId);
        if (!routineRun || FINAL_ROUTINE_STATUSES.has(routineRun.status)) {
          halt(row, routineRun?.status === "failed" ? "failed" : "stopped", "run_stopped", routineRun?.error ?? "The run ended while Seira was not running it.");
        } else if (routineRun.status !== "queued") resume(row);
      }
      store.prune();
    },

    close() {
      for (const cancel of timers.values()) cancel();
      timers.clear();
      live.clear();
    },
  };
}
