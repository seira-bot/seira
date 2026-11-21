// The paste step: a prompt to copy into another AI, and the reader of the answer that comes back.
import { AI_IMPORT_LIMITS } from "./limits.ts";
import type { PasteSource } from "./api.ts";

export const PASTE_SOURCES: readonly PasteSource[] = ["chatgpt", "claude-ai", "gemini", "grok", "copilot", "other"];

export const ABOUT_YOU_HEADING = "About you";
export const HOW_TO_REPLY_HEADING = "How to reply";

const SHARED_ASK = [
  "Write out everything you have saved or learned about me, as plain text. Do not summarize, merge or leave anything out.",
  `Use exactly two headings, "${ABOUT_YOU_HEADING}" and "${HOW_TO_REPLY_HEADING}".`,
  `Under "${ABOUT_YOU_HEADING}", write one fact per line: my name, work, projects, people, places, tools and anything else you remember.`,
  `Under "${HOW_TO_REPLY_HEADING}", write one rule per line: the tone, length, language and format I ask you to use.`,
  "Start every line with a dash. Put each line on its own row. Add no other text.",
].join("\n");

const LEAD: Record<PasteSource, string> = {
  chatgpt: "Look at your saved memories and at my custom instructions.",
  "claude-ai": "Look at your memory of me and at my profile preferences.",
  gemini: "Look at the information you saved about me and at my instructions for Gemini.",
  grok: "Look at everything you remember about me and at my custom instructions.",
  copilot: "Look at everything you remember about me and at my custom instructions.",
  other: "Look at everything you remember about me and at any instructions I gave you.",
};

export function pastePrompt(ai: PasteSource): string {
  return `${LEAD[ai]}\n${SHARED_ASK}`;
}

export interface PastedMemory {
  aboutYou: string[];
  howToReply: string[];
}

const HEADING = /^(?:#{1,6}\s*|\*{1,2}|_{1,2})?\s*([^:*_#]{1,60}?)\s*(?:\*{1,2}|_{1,2})?\s*:?\s*$/;
const ABOUT_WORDS = /^(?:about\s+(?:you|me|the\s+user)|facts?|memor(?:y|ies)|profile|personal|background)$/i;
const REPLY_WORDS = /^(?:how\s+to\s+(?:reply|respond|answer)|instructions?|rules?|style|tone|preferences|response\s+(?:style|preferences)|custom\s+instructions?)$/i;
const BULLET = /^\s*(?:[-*•–—]|\d{1,3}[.)])\s+/;
const DATE_PREFIX = /^\[?\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?Z?)?\]?\s*[:\-–—]?\s*/;
const RULE_START = /^(?:always|never|please|do not|don't|dont|avoid|prefer|use|keep|be|answer|reply|respond|write|format|speak|explain|give|start|end|skip|stop|no\s+\w+|only|make|try|stay|when|if)\b/i;

function headingGroup(line: string): "about" | "reply" | null {
  if (BULLET.test(line)) return null;
  const match = HEADING.exec(line.trim());
  if (!match) return null;
  const word = match[1]!.trim();
  if (ABOUT_WORDS.test(word)) return "about";
  if (REPLY_WORDS.test(word)) return "reply";
  return null;
}

function clean(line: string): string {
  return line.replace(BULLET, "").replace(DATE_PREFIX, "").replace(/^[*_`]+|[*_`]+$/g, "").replace(/\s+/g, " ").trim();
}

/** A line under a heading goes with that heading. A line with no heading above it is a rule when it reads like an
 * instruction to the AI, and a fact about the person otherwise. */
export function parsePaste(text: string): PastedMemory {
  const aboutYou: string[] = [];
  const howToReply: string[] = [];
  let group: "about" | "reply" | null = null;
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const heading = headingGroup(raw);
    if (heading) {
      group = heading;
      continue;
    }
    if (/^#{1,6}\s/.test(raw.trim()) && !BULLET.test(raw)) {
      group = null;
      continue;
    }
    const line = clean(raw);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const target = group ?? (RULE_START.test(line) ? "reply" : "about");
    (target === "reply" ? howToReply : aboutYou).push(line);
  }
  return { aboutYou, howToReply };
}

export type PasteCheck = { ok: true } | { ok: false; reason: "empty" | "too-long" };

export function checkPaste(text: string): PasteCheck {
  if (!text.trim()) return { ok: false, reason: "empty" };
  if (text.length > AI_IMPORT_LIMITS.pasteChars) return { ok: false, reason: "too-long" };
  return { ok: true };
}
