import { Plus } from "lucide-react";

import type { Workflow } from "../../../shared/workflows";
import { listOf } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { botIdsOf, stepsText } from "@/lib/workflow-graph";
import { SeiraCharacter } from "../seira-character";
import { WorkflowThumb } from "./WorkflowThumb";

export const routineLabel = (routine: Pick<Routine, "name" | "prompt">): string => routine.name.trim() || routine.prompt.trim().slice(0, 40);

export function WorkflowList({ workflows, routines, botName, gone, onOpen, onNew }: {
  workflows: Workflow[];
  routines: readonly Routine[];
  botName: (botId: string) => string | undefined;
  gone: boolean;
  onOpen: (workflowId: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
        {gone && <p role="status" data-workflow-gone className="mb-4 rounded-lg bg-warning/10 p-3 text-[13px] leading-[18px] text-warning">{t("workflow.gone")}</p>}
        {workflows.length === 0 ? (
          <section aria-label={t("workflow.view")} className="px-6 py-16 text-center">
            <SeiraCharacter state="sleep" size={96} className="mx-auto mb-2" />
            <p className="mx-auto max-w-sm text-[15px] leading-snug text-ink">{t("workflow.list.empty")}</p>
            <button type="button" onClick={onNew} className="ui-button ui-button-primary mt-6">
              <Plus size={15} aria-hidden />{t("workflow.new")}
            </button>
          </section>
        ) : (
          <ul aria-label={t("workflow.list.label")} className="divide-y divide-hairline/30 overflow-hidden rounded-2xl border border-hairline/40 bg-card">
            {workflows.map((workflow) => {
              const using = routines.filter((routine) => routine.workflowId === workflow.id).map(routineLabel);
              const bots = botIdsOf(workflow).flatMap((id) => botName(id) ?? []);
              const count = workflow.steps.filter((step) => step.kind !== "note").length;
              return (
                <li key={workflow.id} data-workflow={workflow.id}>
                  <button type="button" onClick={() => onOpen(workflow.id)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left outline-none hover:bg-raised/60 focus-visible:bg-raised/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
                    <WorkflowThumb graph={workflow} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium leading-snug text-ink" dir="auto">{workflow.name}</span>
                      <span className="mt-0.5 block text-[13px] text-ink-secondary">{[stepsText(count), bots.length ? listOf(bots) : ""].filter(Boolean).join(" · ")}</span>
                      <span className="mt-0.5 block text-[13px] text-ink-tertiary">{using.length ? t("workflow.list.usedBy", { routines: listOf(using) }) : t("workflow.list.unused")}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
