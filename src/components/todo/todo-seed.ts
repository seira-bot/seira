import { TODO_NOTE_CHARS, TODO_QUOTE_CHARS, TODO_TITLE_CHARS } from "../../../shared/todo";

export interface TodoSeed {
  title: string;
  note: string;
  quote: string;
}

function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]+(\S)/g, "$1$2")
    .replace(/(\S)[*_]+(\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > max * 0.6 ? head.slice(0, space) : head).trim();
}

/** The title is the first line of the text without Markdown. The note is what the title leaves out. The quote starts the
 * source line: the selection, or the start of the message. */
export function todoSeed(text: string, selection?: string): TodoSeed {
  const source = (selection?.trim() ? selection : text).replace(/\r\n?/g, "\n").trim();
  const lines = source.split("\n").map(plainLine).filter(Boolean);
  const first = lines[0] ?? "";
  const title = cut(first, TODO_TITLE_CHARS);
  const rest = first.length > TODO_TITLE_CHARS ? lines.join("\n") : lines.slice(1).join("\n");
  return { title, note: rest.slice(0, TODO_NOTE_CHARS), quote: cut(lines.join(" "), TODO_QUOTE_CHARS) };
}
