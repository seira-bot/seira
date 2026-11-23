// Fixed jobs for the screen tests: one per state, with synthetic names.
import { emptyCounts, type ImportJobView } from "../../../shared/ai-import/api";

export function job(overrides: Partial<ImportJobView> = {}): ImportJobView {
  return {
    id: "job-1", source: { kind: "chatgpt" }, state: "ready", createdAt: 1_000, updatedAt: 2_000,
    progress: { done: 10, total: 40, unit: "items" }, counts: { ...emptyCounts(), conversations: 12, messages: 340, memories: 5, leftovers: 2 },
    agents: [], report: null, undoUntil: null, undoResult: null, error: null, ...overrides,
  };
}

export const READY = job({
  agents: [
    { ref: "a1", name: "Sample project", destination: { kind: "new" }, counts: { ...emptyCounts(), conversations: 12, messages: 340, memories: 5, skills: 1, routines: 2 } },
    { ref: "a2", name: "Sample helper", destination: { kind: "bot", botId: "b-9" }, counts: { ...emptyCounts(), memories: 3 } },
  ],
});

export const DONE = job({
  state: "done",
  undoUntil: Date.UTC(2030, 0, 8),
  report: {
    added: 21, updated: 3, keptBoth: 2,
    leftovers: [
      { ref: "c-4", kind: "conversation", name: "Broken chat", reason: "unreadable" },
      { ref: "f-1", kind: "attachment", reason: "not-in-export" },
    ],
    next: {
      addKey: [{ botId: "b1", botName: "Sample project", tool: "notes", keys: ["NOTES_KEY"] }],
      allowSkill: [{ botId: "b1", botName: "Sample project", skill: "pdf-tools" }],
      connectAgain: [{ botId: "b1", botName: "Sample project", channel: "telegram" }],
      resumeRoutine: [{ botId: "b1", botName: "Sample project", routine: "Morning digest" }],
    },
  },
});
