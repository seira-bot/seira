import type { ImportAgent, ImportConversation, ImportLeftover, ImportSource } from "../../shared/ai-import/bundle.ts";

/** What the reading pass leaves next to the spool of conversations. */
export interface ReadSummary {
  source: ImportSource;
  agents: ImportAgent[];
  leftovers: ImportLeftover[];
  conversations: number;
  messages: number;
}

/** One line of the spool: a conversation and the agent it belongs to. */
export interface SpoolLine {
  agentRef: string;
  conversation: ImportConversation;
}

export const CHATS_FILE = "chats.jsonl";
export const SUMMARY_FILE = "summary.json";
