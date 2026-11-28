import type { AppTriggerManager } from "../app-triggers.ts";
import type { Routine, RoutineManager } from "../routines.ts";
import type { WebhookManager } from "../webhooks.ts";
import { PLACE_LOST_MESSAGE } from "../place-lost.ts";
import { workflowRefusal } from "../workflows/routine-link.ts";

export type WorkflowStartKind = "routine" | "webhook" | "app";

/** One thing that starts an automation: a schedule routine, a webhook or an app event. */
export interface WorkflowStart {
  kind: WorkflowStartKind;
  id: string;
  name: string;
  enabled: boolean;
  botId: string;
}

/** A start as it stands, for the step that turns it into a workflow. `refusal`: why its settings cannot run steps. */
export interface WorkflowStartInfo extends WorkflowStart {
  prompt: string;
  workflowId?: string;
  refusal: string | null;
  routine?: Routine;
}

export interface WorkflowStartsDeps {
  routines(): Pick<RoutineManager, "listRoutines" | "update"> | null;
  webhooks(): Pick<WebhookManager, "list" | "update"> | null;
  appTriggers(): Pick<AppTriggerManager, "list" | "update"> | null;
  /** Why this bot may not watch this app, or null when it may. */
  appAccessRefusal?: (botId: string, app: string) => string | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface WorkflowStarts {
  /** Every start that runs this workflow's steps. */
  list(workflowId: string): WorkflowStart[];
  describe(kind: WorkflowStartKind, id: string): WorkflowStartInfo | null;
  /** Why a switch cannot change every start, or null. Nothing has changed when it answers. */
  switchRefusal(workflowId: string, enabled: boolean): string | null;
  /** Why a run for this start may not go to this bot, or null. Only an app start can refuse. */
  runRefusal(kind: WorkflowStartKind, id: string, botId: string): string | null;
  /** Puts the schedule routines back to the switches a list recorded. */
  restoreRoutines(before: readonly WorkflowStart[]): void;
  /** Puts the webhooks and app triggers back to the switches a list recorded. */
  restoreEvents(before: readonly WorkflowStart[]): Promise<void>;
  setRoutinesEnabled(workflowId: string, enabled: boolean): void;
  /** Webhooks and app triggers. */
  setEventsEnabled(workflowId: string, enabled: boolean): Promise<void>;
  /** Copies the steps to the webhooks and app triggers that hold an older copy. */
  rewriteEvents(workflowId: string, copy: { prompt: string; botId: string }): Promise<void>;
  /** Cuts every webhook and app trigger off the workflow and switches it off. */
  unlinkEvents(workflowId: string): Promise<void>;
  linkEvent(kind: "webhook" | "app", id: string, workflowId: string): Promise<void>;
}

export function createWorkflowStarts(deps: WorkflowStartsDeps): WorkflowStarts {
  const routinesOf = (workflowId: string) => deps.routines()?.listRoutines().filter((routine) => routine.workflowId === workflowId) ?? [];
  const webhooksOf = (workflowId: string) => deps.webhooks()?.list().filter((webhook) => webhook.workflowId === workflowId) ?? [];
  const appsOf = (workflowId: string) => deps.appTriggers()?.list().filter((trigger) => trigger.workflowId === workflowId) ?? [];
  const attempt = async (what: string, work: () => unknown) => {
    try {
      await work();
    } catch (error) {
      deps.log?.(`workflows: could not update ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const eventRefusal = (fields: { runOn: string; sameConversation?: boolean; delivery?: string }) =>
    workflowRefusal({ target: "bot", runOn: fields.runOn, sameConversation: fields.sameConversation, deliver: fields.delivery === "post" ? "post" : undefined, scheduleType: "event" });

  const now = deps.now ?? Date.now;

  return {
    switchRefusal(workflowId, enabled) {
      if (!enabled) return null;
      for (const routine of routinesOf(workflowId)) {
        if (routine.enabled) continue;
        if (routine.placeLost) return PLACE_LOST_MESSAGE;
        if (routine.schedule.type === "once" && routine.schedule.at <= now()) return "Its time has passed. Edit it to pick a new time.";
      }
      for (const webhook of webhooksOf(workflowId)) if (!webhook.enabled && webhook.placeLost) return PLACE_LOST_MESSAGE;
      for (const trigger of appsOf(workflowId)) {
        if (trigger.enabled) continue;
        if (trigger.placeLost) return PLACE_LOST_MESSAGE;
        const short = deps.appAccessRefusal?.(trigger.botId, trigger.app);
        if (short) return short;
      }
      return null;
    },
    runRefusal(kind, id, botId) {
      const trigger = kind === "app" ? deps.appTriggers()?.list().find((candidate) => candidate.id === id) : undefined;
      return trigger ? deps.appAccessRefusal?.(botId, trigger.app) ?? null : null;
    },
    restoreRoutines(before) {
      for (const start of before) if (start.kind === "routine") try { deps.routines()?.update(start.id, { enabled: start.enabled }); } catch { /* the switch had already failed */ }
    },
    async restoreEvents(before) {
      for (const start of before) {
        if (start.kind === "webhook") await attempt(`webhook ${start.id}`, () => deps.webhooks()?.update(start.id, { enabled: start.enabled }));
        else if (start.kind === "app") await attempt(`app trigger ${start.id}`, () => deps.appTriggers()?.update(start.id, { enabled: start.enabled }));
      }
    },
    list(workflowId) {
      return [
        ...routinesOf(workflowId).map((routine): WorkflowStart => ({ kind: "routine", id: routine.id, name: routine.name, enabled: routine.enabled, botId: routine.botId })),
        ...webhooksOf(workflowId).map((webhook): WorkflowStart => ({ kind: "webhook", id: webhook.id, name: webhook.name, enabled: webhook.enabled, botId: webhook.botId })),
        ...appsOf(workflowId).map((trigger): WorkflowStart => ({ kind: "app", id: trigger.id, name: trigger.name, enabled: trigger.enabled, botId: trigger.botId })),
      ];
    },
    describe(kind, id) {
      if (kind === "routine") {
        const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === id);
        return routine ? {
          kind, id, name: routine.name, enabled: routine.enabled, botId: routine.botId, prompt: routine.prompt, workflowId: routine.workflowId, routine,
          refusal: workflowRefusal({ ...routine, scheduleType: routine.schedule.type }),
        } : null;
      }
      const start = kind === "webhook" ? deps.webhooks()?.list().find((candidate) => candidate.id === id) : deps.appTriggers()?.list().find((candidate) => candidate.id === id);
      if (!start) return null;
      const delivery = "delivery" in start && start.delivery === "post" ? "post" : undefined;
      return {
        kind, id, name: start.name, enabled: start.enabled, botId: start.botId, prompt: start.prompt, workflowId: start.workflowId,
        refusal: eventRefusal({ runOn: start.runOn, sameConversation: start.sameConversation, delivery }),
      };
    },
    setRoutinesEnabled(workflowId, enabled) {
      for (const routine of routinesOf(workflowId)) if (routine.enabled !== enabled) deps.routines()?.update(routine.id, { enabled });
    },
    async setEventsEnabled(workflowId, enabled) {
      for (const webhook of webhooksOf(workflowId)) if (webhook.enabled !== enabled) deps.webhooks()?.update(webhook.id, { enabled });
      for (const trigger of appsOf(workflowId)) if (trigger.enabled !== enabled) await deps.appTriggers()?.update(trigger.id, { enabled });
    },
    async rewriteEvents(workflowId, copy) {
      const stale = (start: { prompt: string; botId: string }) => start.prompt !== copy.prompt || start.botId !== copy.botId;
      for (const webhook of webhooksOf(workflowId).filter(stale)) await attempt(`webhook ${webhook.id}`, () => deps.webhooks()?.update(webhook.id, { rewriteWorkflow: true }));
      for (const trigger of appsOf(workflowId).filter(stale)) await attempt(`app trigger ${trigger.id}`, () => deps.appTriggers()?.update(trigger.id, { rewriteWorkflow: true }));
    },
    async unlinkEvents(workflowId) {
      for (const webhook of webhooksOf(workflowId)) await attempt(`webhook ${webhook.id}`, () => deps.webhooks()?.update(webhook.id, { workflowId: null, enabled: false }));
      for (const trigger of appsOf(workflowId)) await attempt(`app trigger ${trigger.id}`, () => deps.appTriggers()?.update(trigger.id, { workflowId: null, enabled: false }));
    },
    async linkEvent(kind, id, workflowId) {
      if (kind === "webhook") deps.webhooks()?.update(id, { workflowId });
      else await deps.appTriggers()?.update(id, { workflowId });
    },
  };
}
