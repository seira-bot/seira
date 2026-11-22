// A source-map upload gives each bundle file a debug id, and the build writes the id into the file. The bundle keeps
// the ids in globalThis._sentryDebugIds, keyed by the stack text of the place that wrote them. A crash report names
// the file instead, so the report service can find the source map without reading a stack key.
const MAX_FILES = 20;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRAME_FILE = /(?:\(|\bat\s+)(\S+?):\d+:\d+\)?\s*$/;

/** The bundle file → debug id map of a debug-id table, or undefined when the table has none. */
export function debugIdsByFile(table: unknown): Record<string, string> | undefined {
  if (!table || typeof table !== "object") return undefined;
  const found: Record<string, string> = {};
  let count = 0;
  for (const [stack, id] of Object.entries(table as Record<string, unknown>)) {
    if (count >= MAX_FILES) break;
    if (typeof id !== "string" || !ID.test(id)) continue;
    const file = stack.split("\n").map((line) => FRAME_FILE.exec(line.trim())?.[1]).find((name): name is string => Boolean(name));
    if (!file) continue;
    const key = file.replace(/^file:\/\//, "").slice(0, 300);
    if (key in found) continue;
    found[key] = id.toLowerCase();
    count++;
  }
  return count ? found : undefined;
}
