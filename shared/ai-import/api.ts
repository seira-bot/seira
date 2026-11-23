// Wire contract between the import hub and the server.
//
// Routes under AI_IMPORT_PATH:
//   POST /uploads          raw body, header x-seira-file-name   → { uploadId: string }
//   GET  /local                                                → { sources: LocalSourceView[] }
//   POST /jobs             CreateImportJob                     → ImportJobView
//   GET  /jobs                                                 → { jobs: ImportJobView[] }
//   GET  /jobs/:id                                             → ImportJobView
//   POST /jobs/:id/apply   ApplyImportJob                      → ImportJobView
//   POST /jobs/:id/cancel                                      → ImportJobView
//   POST /jobs/:id/undo                                        → ImportJobView
// Every job change is also broadcast on the event stream as AiImportEvent.

import type { ImportLeftover, ImportSourceKind } from "./bundle.ts";

export const AI_IMPORT_PATH = "/api/ai-import";
export const AI_IMPORT_FILE_NAME_HEADER = "x-seira-file-name";
export const AI_IMPORT_EVENT = "ai-import";

export type ImportJobState = "queued" | "reading" | "ready" | "applying" | "done" | "partly-done" | "failed" | "undone" | "cancelled";

/** `secret-file`: the export holds a key or password file. `bad-export`: the export file's own manifest is broken. */
export type ImportErrorCode = "unknown-source" | "upload-too-large" | "too-much-data" | "too-many-files" | "unsafe-archive" | "secret-file" | "bad-export" | "worker-failed";

export type ImportDestination = { kind: "new" } | { kind: "bot"; botId: string };

export type PasteSource = "chatgpt" | "claude-ai" | "gemini" | "grok" | "copilot" | "other";

export interface ImportCounts {
  conversations: number;
  messages: number;
  memories: number;
  topics: number;
  skills: number;
  tools: number;
  routines: number;
  channels: number;
  attachments: number;
  leftovers: number;
}

export interface ImportAgentView {
  ref: string;
  name: string;
  counts: ImportCounts;
  destination: ImportDestination;
}

export interface ImportNextSteps {
  addKey: Array<{ botId: string; botName: string; tool: string; keys: string[] }>;
  allowSkill: Array<{ botId: string; botName: string; skill: string }>;
  connectAgain: Array<{ botId: string; botName: string; channel: string }>;
  resumeRoutine: Array<{ botId: string; botName: string; routine: string }>;
}

export interface ImportReport {
  added: number;
  updated: number;
  keptBoth: number;
  leftovers: ImportLeftover[];
  next: ImportNextSteps;
}

/** `kept`: names of items Undo left in place because the person changed them after the import. */
export interface ImportUndoResult {
  removed: number;
  restored: number;
  kept: string[];
}

export interface ImportJobView {
  id: string;
  source: { kind: ImportSourceKind; name?: string; profile?: string };
  state: ImportJobState;
  createdAt: number;
  updatedAt: number;
  progress: { done: number; total: number | null; unit: "bytes" | "items" };
  counts: ImportCounts;
  agents: ImportAgentView[];
  report: ImportReport | null;
  /** Null when Undo is no longer offered. */
  undoUntil: number | null;
  undoResult: ImportUndoResult | null;
  error: ImportErrorCode | null;
}

/** `id` is opaque to the hub: send it back in CreateImportJob, never show it. */
export interface LocalSourceView {
  id: string;
  kind: ImportSourceKind;
  name: string;
  profile?: string;
}

export type InstructionsAs = "persona" | "about-you";

export type CreateImportJob =
  | { from: "upload"; uploadIds: string[] }
  | { from: "local"; sourceId: string; transcripts?: boolean; instructions?: InstructionsAs }
  | { from: "paste"; ai: PasteSource; aboutYou: string[]; howToReply: string[]; destination: ImportDestination };

export interface ApplyImportJob {
  destinations: Record<string, ImportDestination>;
}

export interface AiImportEvent {
  type: typeof AI_IMPORT_EVENT;
  job: ImportJobView;
}

export function emptyCounts(): ImportCounts {
  return { conversations: 0, messages: 0, memories: 0, topics: 0, skills: 0, tools: 0, routines: 0, channels: 0, attachments: 0, leftovers: 0 };
}
