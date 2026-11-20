import { FileText, Workflow as WorkflowIcon } from "lucide-react";

import { t } from "@/lib/i18n";
import { useWorkflows } from "@/state/workflows";
import { Segmented } from "../bot-panel/rows";
import { WorkflowSlot, type WhatItDoesWorkflow } from "./WorkflowSlot";

export type { WhatItDoesWorkflow } from "./WorkflowSlot";
export { WorkflowRoutineSection } from "../workflow/WorkflowRoutineSection";

function Instructions({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return (
    <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={5} aria-label={label} placeholder={placeholder} className="min-w-0 flex-1 resize-y rounded-xl border border-hairline/50 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
  );
}

function Choosing({ workflow, ...instructions }: { value: string; onChange: (value: string) => void; placeholder: string; label: string; workflow: WhatItDoesWorkflow }) {
  const mode = workflow.choice.mode;
  const Icon = mode === "workflow" ? WorkflowIcon : FileText;
  return (
    <div className="flex items-start gap-4">
      <Icon size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
      <div className="min-w-0 flex-1 space-y-3">
        <Segmented attr="data-what-it-does" label={t("workflow.slot.label")} value={mode}
          options={[{ value: "instructions", label: t("workflow.slot.instructions") }, { value: "workflow", label: t("workflow.slot.workflow") }]}
          onChange={(next) => workflow.onChange(next === "instructions" ? { mode: "instructions" } : { mode: "workflow", id: null })} />
        {mode === "workflow" ? <WorkflowSlot {...workflow} /> : <div className="flex"><Instructions {...instructions} /></div>}
      </div>
    </div>
  );
}

function Gated(props: { value: string; onChange: (value: string) => void; placeholder: string; label: string; workflow: WhatItDoesWorkflow }) {
  const workflows = useWorkflows();
  const { workflow, ...instructions } = props;
  const ready = workflows.loaded && !(workflows.failed && workflows.workflows.length === 0);
  if (workflows.unavailable || (workflow.choice.mode === "instructions" && !ready)) return <div className="flex items-start gap-4"><FileText size={18} className="mt-2.5 shrink-0 text-ink-secondary" /><Instructions {...instructions} /></div>;
  return <Choosing workflow={workflow} {...instructions} />;
}

export function WhatItDoes({ workflow, ...instructions }: { value: string; onChange: (value: string) => void; placeholder: string; label: string; workflow?: WhatItDoesWorkflow }) {
  if (workflow) return <Gated workflow={workflow} {...instructions} />;
  return (
    <div className="flex items-start gap-4">
      <FileText size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
      <Instructions {...instructions} />
    </div>
  );
}
