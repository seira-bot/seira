import type { WorkflowConnection, WorkflowStep, WorkflowStepKind } from "../../shared/workflows";
import { connectRefusal, findLoop, stepById, type ConnectRefusal } from "@/lib/workflow-graph";
import { fitTeams, type Point, type Tile, type View } from "@/lib/team-canvas";
import { randomUuid } from "@/lib/random-uuid";
import type { WorkflowDraft } from "@/state/workflows";

export const STEP_WIDTH = 248;
export const NOTE_WIDTH = 200;
export const STEP_HEIGHT = 112;
export const GRID = 8;
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 1.5;
export const STEP_DRAG_TYPE = "application/x-seira-step";
export const START_VIEW: View = { x: 40, y: 40, scale: 1 };
const SPOT_GAP = 24;
const SPOT_RINGS = 8;

export type PortSide = "out" | "yes" | "no";
export interface Size { width: number; height: number }

export function snap(point: Point): Point {
  return { x: Math.round(point.x / GRID) * GRID, y: Math.round(point.y / GRID) * GRID };
}

export function stepSize(step: WorkflowStep): Size {
  return { width: step.kind === "note" ? NOTE_WIDTH : STEP_WIDTH, height: STEP_HEIGHT };
}

export function stepTiles(steps: readonly WorkflowStep[]): Tile[] {
  return steps.map((step) => ({ key: step.id, x: step.position.x, y: step.position.y, ...stepSize(step) }));
}

const overlaps = (spot: Point, size: Size, tile: Tile): boolean =>
  spot.x < tile.x + tile.width + SPOT_GAP && spot.x + size.width + SPOT_GAP > tile.x
  && spot.y < tile.y + tile.height + SPOT_GAP && spot.y + size.height + SPOT_GAP > tile.y;

export function freeSpot(steps: readonly WorkflowStep[], near: Point, size: Size = { width: STEP_WIDTH, height: STEP_HEIGHT }): Point {
  const start = snap({ x: near.x - size.width / 2, y: near.y - size.height / 2 });
  const tiles = stepTiles(steps);
  const free = (spot: Point) => !tiles.some((tile) => overlaps(spot, size, tile));
  if (free(start)) return start;
  const dx = size.width + SPOT_GAP;
  const dy = size.height + SPOT_GAP;
  for (let ring = 1; ring <= SPOT_RINGS; ring++) {
    const candidates = [
      { x: start.x + ring * dx, y: start.y },
      { x: start.x, y: start.y + ring * dy },
      { x: start.x - ring * dx, y: start.y },
      { x: start.x, y: start.y - ring * dy },
    ].map(snap);
    const found = candidates.find(free);
    if (found) return found;
  }
  return start;
}

const SIDE_SHARE: Record<PortSide, number> = { out: 1 / 2, yes: 1 / 3, no: 2 / 3 };

export function portPoint(step: WorkflowStep, side: PortSide): Point {
  const { width, height } = stepSize(step);
  return { x: step.position.x + width * SIDE_SHARE[side], y: step.position.y + height };
}

export function inPoint(step: WorkflowStep): Point {
  return { x: step.position.x + stepSize(step).width / 2, y: step.position.y };
}

export function edgePath(from: Point, to: Point): string {
  const reach = Math.max(40, Math.abs(to.y - from.y) / 2);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + reach}, ${to.x} ${to.y - reach}, ${to.x} ${to.y}`;
}

export function edgeMid(from: Point, to: Point): Point {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

export function newId(prefix: "s" | "c"): string {
  return `${prefix}-${randomUuid().slice(0, 8)}`;
}

export function newStep(kind: WorkflowStepKind, position: Point, botId = ""): WorkflowStep {
  const base = { id: newId("s"), position: snap(position) };
  switch (kind) {
    case "bot": return { ...base, kind, botId, instruction: "" };
    case "check": return { ...base, kind, question: "" };
    case "wait": return { ...base, kind, minutes: 60 };
    case "post": return { ...base, kind };
    case "note": return { ...base, kind, text: "" };
  }
}

export interface Removal { step: WorkflowStep; index: number; connections: WorkflowConnection[] }

export function removalOf(draft: WorkflowDraft, stepId: string): Removal | null {
  const index = draft.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return null;
  return {
    step: draft.steps[index]!,
    index,
    connections: draft.connections.filter((connection) => connection.from === stepId || connection.to === stepId),
  };
}

export type DraftAction =
  | { type: "add"; step: WorkflowStep; after?: { stepId: string; connectionId: string } }
  | { type: "move"; stepId: string; position: Point }
  | { type: "change"; stepId: string; patch: { botId?: string; instruction?: string; question?: string; minutes?: number; text?: string } }
  | { type: "connect"; connection: WorkflowConnection }
  | { type: "disconnect"; connectionId: string }
  | { type: "remove"; stepId: string }
  | { type: "restore"; removal: Removal }
  | { type: "rename"; name: string }
  | { type: "replace"; draft: WorkflowDraft };

/** A check has a Yes and a No slot; any other step has one slot. */
function freeBranch(draft: WorkflowDraft, step: WorkflowStep): { free: boolean; branch?: "yes" | "no" } {
  const taken = draft.connections.filter((connection) => connection.from === step.id);
  if (step.kind === "check") {
    if (!taken.some((connection) => connection.branch === "yes")) return { free: true, branch: "yes" };
    if (!taken.some((connection) => connection.branch === "no")) return { free: true, branch: "no" };
    return { free: false };
  }
  return { free: taken.length === 0 };
}

function patched(step: WorkflowStep, patch: Extract<DraftAction, { type: "change" }>["patch"]): WorkflowStep {
  switch (step.kind) {
    case "bot": return { ...step, botId: patch.botId ?? step.botId, instruction: patch.instruction ?? step.instruction };
    case "check": return { ...step, question: patch.question ?? step.question };
    case "wait": return { ...step, minutes: patch.minutes ?? step.minutes };
    case "note": return { ...step, text: patch.text ?? step.text };
    case "post": return step;
  }
}

export function draftReducer(draft: WorkflowDraft, action: DraftAction): WorkflowDraft {
  switch (action.type) {
    case "add": {
      const steps = [...draft.steps, action.step];
      const from = action.after ? stepById(draft, action.after.stepId) : undefined;
      if (!from || !action.after || from.kind === "note" || action.step.kind === "note") return { ...draft, steps };
      const slot = freeBranch(draft, from);
      if (!slot.free) return { ...draft, steps };
      const connection: WorkflowConnection = { id: action.after.connectionId, from: from.id, to: action.step.id, ...(slot.branch ? { branch: slot.branch } : {}) };
      return { ...draft, steps, connections: [...draft.connections, connection] };
    }
    case "move":
      return { ...draft, steps: draft.steps.map((step) => step.id === action.stepId ? { ...step, position: snap(action.position) } : step) };
    case "change":
      return { ...draft, steps: draft.steps.map((step) => step.id === action.stepId ? patched(step, action.patch) : step) };
    case "connect": {
      const { connection } = action;
      const from = stepById(draft, connection.from);
      if (!from || connectRefusal(draft, connection.from, connection.to, connection.branch)) return draft;
      const kept = draft.connections.filter((existing) => existing.from !== connection.from || (from.kind === "check" && existing.branch !== connection.branch));
      return { ...draft, connections: [...kept, connection] };
    }
    case "disconnect":
      return { ...draft, connections: draft.connections.filter((connection) => connection.id !== action.connectionId) };
    case "remove":
      return {
        ...draft,
        steps: draft.steps.filter((step) => step.id !== action.stepId),
        connections: draft.connections.filter((connection) => connection.from !== action.stepId && connection.to !== action.stepId),
      };
    case "restore": {
      const { step, index, connections } = action.removal;
      if (draft.steps.some((existing) => existing.id === step.id)) return draft;
      const steps = [...draft.steps];
      steps.splice(Math.min(index, steps.length), 0, step);
      let next: WorkflowDraft = { ...draft, steps };
      for (const connection of connections) {
        const from = stepById(next, connection.from);
        if (!from || !stepById(next, connection.to)) continue;
        const taken = next.connections.filter((existing) => existing.from === from.id);
        const slotFree = from.kind === "check" ? !taken.some((existing) => existing.branch === connection.branch) : taken.length === 0;
        if (!slotFree) continue;
        const joined = { ...next, connections: [...next.connections, connection] };
        if (!findLoop(joined)) next = joined;
      }
      return next;
    }
    case "rename":
      return { ...draft, name: action.name };
    case "replace":
      return action.draft;
  }
}

export function fitSteps(steps: readonly WorkflowStep[], width: number, height: number): View {
  if (steps.length === 0 || width <= 0 || height <= 0) return START_VIEW;
  return fitTeams(stepTiles(steps), width, height);
}

export function refusalKey(refusal: ConnectRefusal): "workflow.refuse.self" | "workflow.refuse.loop" | "workflow.problem.noteConnected" {
  return refusal === "self" ? "workflow.refuse.self" : refusal === "loop" ? "workflow.refuse.loop" : "workflow.problem.noteConnected";
}

export function thumbLayout(graph: Pick<WorkflowDraft, "steps" | "connections">, width: number, height: number): {
  boxes: Array<{ id: string; kind: WorkflowStepKind; x: number; y: number; width: number; height: number }>;
  lines: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>;
} {
  const tiles = stepTiles(graph.steps);
  if (tiles.length === 0) return { boxes: [], lines: [] };
  const left = Math.min(...tiles.map((tile) => tile.x));
  const top = Math.min(...tiles.map((tile) => tile.y));
  const contentWidth = Math.max(...tiles.map((tile) => tile.x + tile.width)) - left;
  const contentHeight = Math.max(...tiles.map((tile) => tile.y + tile.height)) - top;
  const pad = 4;
  const scale = Math.min((width - pad * 2) / contentWidth, (height - pad * 2) / contentHeight);
  const offsetX = (width - contentWidth * scale) / 2 - left * scale;
  const offsetY = (height - contentHeight * scale) / 2 - top * scale;
  const boxes = graph.steps.map((step, index) => {
    const tile = tiles[index]!;
    return { id: step.id, kind: step.kind, x: tile.x * scale + offsetX, y: tile.y * scale + offsetY, width: tile.width * scale, height: tile.height * scale };
  });
  const byId = new Map(boxes.map((box) => [box.id, box] as const));
  const lines = graph.connections.flatMap((connection) => {
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    return from && to ? [{ id: connection.id, x1: from.x + from.width / 2, y1: from.y + from.height, x2: to.x + to.width / 2, y2: to.y }] : [];
  });
  return { boxes, lines };
}
