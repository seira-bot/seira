import type { DatabaseSync } from "node:sqlite";

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
  from?: string;
}

function matchSpan(text: string, needle: string): { start: number; length: number } | null {
  const folded = text.toLowerCase();
  const hit = folded.indexOf(needle);
  if (hit < 0) return null;
  if (folded.length === text.length) return { start: hit, length: needle.length };
  let at = 0, foldedAt = 0, start: number | undefined;
  for (const character of text) {
    const next = at + character.length;
    const foldedNext = foldedAt + character.toLowerCase().length;
    if (start === undefined && hit < foldedNext) start = at;
    if (hit + needle.length <= foldedNext) return { start: start!, length: next - start! };
    at = next;
    foldedAt = foldedNext;
  }
  return null;
}

// Snippets show text, not Markdown: keep link labels and drop emphasis, code ticks and line markers.
export function markdownToPlain(text: string): string {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`+([^`\n]+)`+/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)/gm, "");
}

// Markdown is converted only near the hit, so a huge or malformed message costs the same as a short one.
const PLAIN_MARGIN = 250;
const PLAIN_MAX_MATCH = 500;

// The raw text around a hit, widened to whole lines when they are short: no Markdown construct crosses a line.
// A long line is cut at whitespace instead, which never falls inside a link target.
function plainWindow(raw: string, hit: { start: number; length: number }): { start: number; end: number } {
  const hitEnd = hit.start + hit.length;
  const from = Math.max(0, hit.start - PLAIN_MARGIN);
  const to = Math.min(raw.length, hitEnd + PLAIN_MARGIN);
  const lineStart = from === 0 ? 0 : raw.lastIndexOf("\n", from - 1) + 1;
  const lineEnd = raw.indexOf("\n", to) < 0 ? raw.length : raw.indexOf("\n", to);
  const space = raw.slice(from, hit.start).search(/\s/);
  const lastSpace = raw.slice(hitEnd, to).search(/\s\S*$/);
  return {
    start: from - lineStart <= PLAIN_MARGIN ? lineStart : space < 0 ? hit.start : from + space,
    end: lineEnd - to <= PLAIN_MARGIN ? lineEnd : lastSpace < 0 ? hitEnd : hitEnd + lastSpace,
  };
}

export function searchMessagesInDatabase(database: DatabaseSync, query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // SQLite's built-in lower() folds ASCII only; match the query and snippet's Unicode lowercase rules.
  database.function("seira_search_lower", { deterministic: true }, (value) => typeof value === "string" ? value.toLowerCase() : null);
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  const scope = threadId ? "thread_id = ? AND " : "";
  const statement = database.prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND seira_search_lower(text) LIKE ? ESCAPE '\\') ` +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND seira_search_lower(tool_name) LIKE ? ESCAPE '\\')) " +
      "ORDER BY at DESC LIMIT ?",
  );
  const rows = (threadId
    ? statement.all(threadId, pattern, pattern, limit)
    : statement.all(pattern, pattern, limit)) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
  return rows.map((row) => {
    const raw = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
    const rawHit = matchSpan(raw, needle) ?? { start: 0, length: 0 };
    let haystack = raw, hit = rawHit, cutBefore = false, cutAfter = false;
    if (row.kind !== "activity" && rawHit.length <= PLAIN_MAX_MATCH) {
      const window = plainWindow(raw, rawHit);
      const plain = markdownToPlain(raw.slice(window.start, window.end));
      // A query that names Markdown itself ("**bold") still finds its place in the raw text.
      const plainHit = matchSpan(plain, needle);
      if (plainHit) {
        haystack = plain;
        hit = plainHit;
        cutBefore = window.start > 0;
        cutAfter = window.end < raw.length;
      }
    }
    const start = Math.max(0, hit.start - 60);
    const end = Math.min(haystack.length, hit.start + hit.length + 90);
    const head = start > 0 || cutBefore ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length || cutAfter ? "…" : "");
    const folded = needle.replace(/\s+/g, " ");
    const match = matchSpan(snippet, folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: match?.start ?? head.length,
      matchLength: match?.length ?? 0,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
}
