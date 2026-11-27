import type { Todo } from "../../../shared/todo";

let tick = 1000;

export const todoOf = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id, title: `Title ${id}`, status: "queued", start: { kind: "free" }, rank: 1, madeBy: { kind: "person", name: "Rama" },
  attempts: 0, depth: 0, createdAt: ++tick, updatedAt: tick, ...extra,
});

export const botsOf = [
  { id: "felix", name: "Felix", color: "blue" },
  { id: "rhea", name: "Rhea", color: "green" },
];
