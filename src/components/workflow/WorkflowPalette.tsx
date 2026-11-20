import { Bot, Hourglass, Send, Split, StickyNote, type LucideIcon } from "lucide-react";

import type { WorkflowStepKind } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { STEP_DRAG_TYPE } from "@/lib/workflow-canvas";
import { KIND_LABEL } from "@/lib/workflow-graph";

const ITEMS: Array<{ kind: WorkflowStepKind; icon: LucideIcon }> = [
  { kind: "bot", icon: Bot },
  { kind: "check", icon: Split },
  { kind: "wait", icon: Hourglass },
  { kind: "post", icon: Send },
  { kind: "note", icon: StickyNote },
];

export function WorkflowPalette({ onAdd, disabled }: { onAdd: (kind: WorkflowStepKind) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={t("workflow.palette.label")}
      className="flex flex-col gap-0.5 rounded-xl border border-hairline/60 bg-menu p-1 shadow-sm">
      {ITEMS.map(({ kind, icon: Icon }) => (
        <button key={kind} type="button" disabled={disabled} draggable={!disabled} data-workflow-palette={kind}
          aria-label={t(KIND_LABEL[kind])} title={t(KIND_LABEL[kind])}
          onClick={() => onAdd(kind)}
          onDragStart={(event) => {
            event.dataTransfer.setData(STEP_DRAG_TYPE, kind);
            event.dataTransfer.effectAllowed = "copy";
          }}
          className="flex size-9 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50">
          <Icon size={16} aria-hidden />
        </button>
      ))}
    </div>
  );
}
