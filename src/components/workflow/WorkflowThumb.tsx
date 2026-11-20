import type { WorkflowGraph } from "../../../shared/workflows";
import { thumbLayout } from "@/lib/workflow-canvas";

const WIDTH = 120;
const HEIGHT = 72;

export function WorkflowThumb({ graph }: { graph: WorkflowGraph }) {
  const { boxes, lines } = thumbLayout(graph, WIDTH, HEIGHT);
  return (
    <svg aria-hidden data-workflow-thumb width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="shrink-0 rounded-lg border border-hairline/40 bg-inset">
      {lines.map((line) => <line key={line.id} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="var(--color-ink-tertiary)" strokeWidth={1} />)}
      {boxes.map((box) => (
        <rect key={box.id} x={box.x} y={box.y} width={box.width} height={box.height} rx={3}
          fill={box.kind === "note" ? "var(--color-inset)" : "var(--color-card)"} stroke="var(--color-ink-tertiary)" strokeWidth={1} />
      ))}
    </svg>
  );
}
