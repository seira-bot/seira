import { existsSync, readFileSync } from "node:fs";

/**
 * The rows of a JSON Lines file that another process may still be appending to; none when the file is missing.
 * Linux copies a large append into the file in parts, so a reader can see the start of a row before its end: the text
 * after the last newline is left out until its newline lands.
 */
export function readJsonLines<T = any>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}
