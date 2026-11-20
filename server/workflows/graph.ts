import type { WorkflowConnection, WorkflowGraph, WorkflowStep } from "../../shared/workflows.ts";

export const runnable = (step: WorkflowStep): boolean => step.kind !== "note";

export const stepById = (graph: WorkflowGraph, id: string): WorkflowStep | undefined => graph.steps.find((step) => step.id === id);

const branchRank = (connection: WorkflowConnection): number => (connection.branch === "yes" ? 0 : connection.branch === "no" ? 1 : 2);

/** Yes before No, then the rest in the order saved. */
export function outgoing(graph: WorkflowGraph, stepId: string): WorkflowConnection[] {
  return graph.connections
    .map((connection, index) => ({ connection, index }))
    .filter(({ connection }) => connection.from === stepId)
    .sort((a, b) => branchRank(a.connection) - branchRank(b.connection) || a.index - b.index)
    .map(({ connection }) => connection);
}

export function startSteps(graph: WorkflowGraph): WorkflowStep[] {
  const entered = new Set(graph.connections.map((connection) => connection.to));
  return graph.steps.filter((step) => runnable(step) && !entered.has(step.id));
}

/** The connection that closes the first loop found, or null. Only connections between two runnable steps count. */
export function findLoop(graph: WorkflowGraph): WorkflowConnection | null {
  const ids = new Set(graph.steps.filter(runnable).map((step) => step.id));
  const state = new Map<string, "open" | "closed">();
  const visit = (id: string): WorkflowConnection | null => {
    state.set(id, "open");
    for (const connection of outgoing(graph, id)) {
      if (!ids.has(connection.to)) continue;
      const seen = state.get(connection.to);
      if (seen === "open") return connection;
      if (!seen) {
        const found = visit(connection.to);
        if (found) return found;
      }
    }
    state.set(id, "closed");
    return null;
  };
  for (const step of graph.steps) {
    if (!ids.has(step.id) || state.has(step.id)) continue;
    const found = visit(step.id);
    if (found) return found;
  }
  return null;
}

/** Includes `fromStepId` itself. */
export function reachable(graph: WorkflowGraph, fromStepId: string | undefined): Set<string> {
  const seen = new Set<string>();
  if (fromStepId === undefined) return seen;
  const queue = [fromStepId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const connection of outgoing(graph, id)) queue.push(connection.to);
  }
  return seen;
}

/** From each start step, Yes before No, each runnable step once. */
export function stepOrder(graph: WorkflowGraph): WorkflowStep[] {
  const order: WorkflowStep[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const step = stepById(graph, id);
    if (!step || !runnable(step) || seen.has(id)) return;
    seen.add(id);
    order.push(step);
    for (const connection of outgoing(graph, id)) visit(connection.to);
  };
  for (const start of startSteps(graph)) visit(start.id);
  return order;
}

export function botIdsOf(graph: WorkflowGraph): string[] {
  const ids: string[] = [];
  for (const step of stepOrder(graph)) if (step.kind === "bot" && !ids.includes(step.botId)) ids.push(step.botId);
  return ids;
}

export function stepLabel(step: WorkflowStep, botName: (botId: string) => string | undefined): string {
  switch (step.kind) {
    case "bot": return botName(step.botId) ?? "Bot step";
    case "check": return "AI check";
    case "wait": return "Wait";
    case "post": return "Post results";
    case "note": return "Note";
    default: return "Step";
  }
}
