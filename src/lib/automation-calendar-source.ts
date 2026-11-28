import { automationStatus, automationsFrom, orderAutomations, statusLine, type Automation } from "@/lib/automations";
import type { CalendarAutomation, CalendarStart } from "@/lib/automation-calendar";
import type { Workflow } from "../../shared/workflows";

export type CalendarSources = Parameters<typeof automationsFrom>[0] & { workflows?: readonly Workflow[] };

const runTime = (run: Automation["runs"][number]) => run.startedAt ?? run.scheduledFor ?? run.createdAt;

function stepBots(workflow: Workflow | undefined, fallbackBotId: string): string[] {
  const ids = workflow?.steps.flatMap((step) => (step.kind === "bot" ? [step.botId] : [])) ?? [];
  return ids.length ? ids : [fallbackBotId];
}

export function calendarAutomations(sources: CalendarSources, now = Date.now()): CalendarAutomation[] {
  const workflows = new Map((sources.workflows ?? []).map((workflow) => [workflow.id, workflow]));
  const createdAt = new Map(sources.routines.map((routine) => [routine.id, routine.createdAt]));
  const ordered = orderAutomations(automationsFrom(sources));

  const startOf = (automation: Automation): CalendarStart => {
    if (automation.kind === "schedule" && automation.schedule) {
      const created = createdAt.get(automation.id);
      return {
        id: automation.id, kind: "schedule", schedule: automation.schedule, enabled: automation.enabled, nextRunAt: automation.nextRunAt,
        ...(created !== undefined ? { createdAt: created } : {}),
      };
    }
    return { id: automation.id, kind: automation.kind === "app" ? "app" : "webhook", ...(automation.appTrigger ? { app: automation.appTrigger.app } : {}) };
  };

  const groups = new Map<string, Automation[]>();
  for (const automation of ordered) {
    const key = automation.workflowId ? `workflow:${automation.workflowId}` : `own:${automation.id}`;
    groups.set(key, [...(groups.get(key) ?? []), automation]);
  }

  const result: CalendarAutomation[] = [...groups.values()].map((members): CalendarAutomation => {
    const lead = members[0]!;
    const workflow = lead.workflowId ? workflows.get(lead.workflowId) : undefined;
    return {
      id: lead.workflowId ?? lead.id,
      name: workflow?.name ?? lead.name,
      enabled: members.some((member) => member.enabled),
      draft: false,
      manual: false,
      needsYou: members.some((member) => automationStatus(member, now).state === "needs-you"),
      statusLine: statusLine(lead, now),
      starts: members.map(startOf),
      stepBotIds: stepBots(workflow, lead.botId),
      runs: members.flatMap((member) => member.runs).sort((left, right) => runTime(right) - runTime(left)),
      ...(lead.workflowId ? { workflowId: lead.workflowId } : {}),
    };
  });

  const used = new Set(ordered.flatMap((automation) => (automation.workflowId ? [automation.workflowId] : [])));
  const drafts = [...workflows.values()].filter((workflow) => !used.has(workflow.id)).sort((left, right) => right.updatedAt - left.updatedAt);
  for (const workflow of drafts) {
    result.push({
      id: workflow.id, name: workflow.name, enabled: false, draft: true, manual: false, needsYou: false, statusLine: "",
      starts: [], stepBotIds: stepBots(workflow, ""), runs: [], workflowId: workflow.id,
    });
  }
  return result;
}
