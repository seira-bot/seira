import { X } from "lucide-react";

import type { WorkflowGraph } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { edgeMid, edgePath, inPoint, portPoint, type PortSide } from "@/lib/workflow-canvas";
import { stepById, stepTitle } from "@/lib/workflow-graph";
import type { Point } from "@/lib/team-canvas";

export interface PendingConnection { from: Point; to: Point }

export function WorkflowEdges({ graph, botName, selectedId, editable, pending, onSelect, onRemove }: {
  graph: WorkflowGraph;
  botName: (botId: string) => string | undefined;
  selectedId: string | null;
  editable: boolean;
  pending: PendingConnection | null;
  onSelect: (connectionId: string) => void;
  onRemove: (connectionId: string) => void;
}) {
  const lines = graph.connections.flatMap((connection) => {
    const from = stepById(graph, connection.from);
    const to = stepById(graph, connection.to);
    if (!from || !to) return [];
    const side: PortSide = connection.branch ?? "out";
    const start = portPoint(from, side);
    const end = inPoint(to);
    return [{ connection, from, to, start, end }];
  });
  const selected = lines.find((line) => line.connection.id === selectedId);
  const mid = selected ? edgeMid(selected.start, selected.end) : null;
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
        <defs>
          <marker id="workflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="var(--color-ink-tertiary)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        {lines.map(({ connection, start, end }) => {
          const d = edgePath(start, end);
          const isSelected = connection.id === selectedId;
          const labelAt = connection.branch ? { x: start.x + (connection.branch === "yes" ? -14 : 14), y: start.y + 18 } : null;
          return (
            <g key={connection.id} data-workflow-connection={connection.id}>
              <path d={d} fill="none" stroke={isSelected ? "var(--color-accent)" : "var(--color-ink-tertiary)"} strokeWidth={isSelected ? 2 : 1.5} markerEnd="url(#workflow-arrow)" />
              {editable && <path d={d} fill="none" stroke="transparent" strokeWidth={12} pointerEvents="stroke" data-workflow-connection-hit={connection.id}
                className="cursor-pointer" onClick={() => onSelect(connection.id)} />}
              {labelAt && connection.branch && !editable && (
                <text x={labelAt.x} y={labelAt.y} textAnchor="middle" fontSize={11} fill="var(--color-ink-secondary)">
                  {t(connection.branch === "yes" ? "workflow.branch.yes" : "workflow.branch.no")}
                </text>
              )}
            </g>
          );
        })}
        {pending && <path d={edgePath(pending.from, pending.to)} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} strokeDasharray="5 4" />}
      </svg>
      {selected && mid && editable && (
        <button type="button" data-workflow-edge-button aria-label={t("workflow.connection.remove", { from: stepTitle(selected.from, botName), to: stepTitle(selected.to, botName) })}
          onClick={() => onRemove(selected.connection.id)}
          className="absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-card text-ink-secondary shadow-sm outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-focus"
          style={{ left: mid.x, top: mid.y }}>
          <X size={13} aria-hidden />
        </button>
      )}
    </>
  );
}
