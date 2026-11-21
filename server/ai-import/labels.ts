import type { PasteSource } from "../../shared/ai-import/api.ts";
import type { ImportSourceKind } from "../../shared/ai-import/bundle.ts";

const SOURCE_LABELS: Record<ImportSourceKind, string> = {
  chatgpt: "ChatGPT",
  "claude-ai": "Claude",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  "claude-code": "Claude Code",
  paste: "another AI",
};

const PASTE_LABELS: Record<PasteSource, string> = {
  chatgpt: "ChatGPT",
  "claude-ai": "Claude",
  gemini: "Gemini",
  grok: "Grok",
  copilot: "Copilot",
  other: "another AI",
};

/** The product name that marks imported chats and memory lines. Product names stay in English in every language. */
export function sourceLabel(kind: ImportSourceKind, paste?: PasteSource): string {
  return kind === "paste" && paste ? PASTE_LABELS[paste] : SOURCE_LABELS[kind];
}
