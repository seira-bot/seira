import { isMentionBoundary, isMentionNameContinuation } from "./mention-boundary.ts";
import type { TodoRepeat, TodoStart } from "./todo.ts";
import { TODO_TITLE_CHARS } from "./todo.ts";

export interface TodoCommandBot {
  id: string;
  name: string;
}

export interface TodoCommandDraft {
  title: string;
  /** The bot an @name picked; absent when the text names none. */
  botId?: string;
  start: TodoStart;
  repeat?: TodoRepeat;
}

const COMMAND = /^\/todo(?:\s+([\s\S]*))?$/i;
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = [1, 2, 3, 4, 5];
const TOMORROW_HOUR = 9;

export function isTodoCommand(text: string): boolean {
  return /^\/todo(?:\s|$)/i.test(text);
}

function clockOf(word: string | undefined): { hours: number; minutes: number } | null {
  const match = word ? CLOCK.exec(word) : null;
  return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
}

function timeText({ hours, minutes }: { hours: number; minutes: number }): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function at(base: Date, dayOffset: number, hours: number, minutes: number): number {
  const day = new Date(base);
  day.setDate(day.getDate() + dayOffset);
  day.setHours(hours, minutes, 0, 0);
  return day.getTime();
}

function takeBot(text: string, bots: readonly TodoCommandBot[]): { rest: string; botId?: string } {
  const named = bots.filter((bot) => bot.name.trim()).sort((a, b) => b.name.length - a.name.length);
  let from = -1;
  while ((from = text.indexOf("@", from + 1)) !== -1) {
    if (!isMentionBoundary(text, from)) continue;
    const rest = text.slice(from + 1);
    const bot = named.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase() && !isMentionNameContinuation(rest.slice(name.length)));
    if (!bot) continue;
    return { botId: bot.id, rest: `${text.slice(0, from)} ${text.slice(from + 1 + bot.name.length)}` };
  }
  return { rest: text };
}

function takeWhen(words: string[], now: Date): { words: string[]; start: TodoStart; repeat?: TodoRepeat } | null {
  const last = words.at(-1)?.toLowerCase();
  const clock = clockOf(last);
  const before = words.at(-2)?.toLowerCase();
  if (clock && (before === "daily" || before === "weekdays")) {
    return { words: words.slice(0, -2), start: { kind: "free" }, repeat: { time: timeText(clock), weekdays: before === "daily" ? [] : [...WEEKDAYS] } };
  }
  if (clock && before === "tomorrow") return { words: words.slice(0, -2), start: { kind: "at", at: at(now, 1, clock.hours, clock.minutes) } };
  if (clock) {
    const today = at(now, 0, clock.hours, clock.minutes);
    return { words: words.slice(0, -1), start: { kind: "at", at: today > now.getTime() ? today : at(now, 1, clock.hours, clock.minutes) } };
  }
  if (last === "tomorrow") return { words: words.slice(0, -1), start: { kind: "at", at: at(now, 1, TOMORROW_HOUR, 0) } };
  return null;
}

/** `/todo <title> [@bot] [when]`. `when` closes the text: `tomorrow`, `tomorrow HH:MM`, `HH:MM` (today, or tomorrow once past),
 * `daily HH:MM` or `weekdays HH:MM`. An @name that no bot has, and any other word, stays in the title. Null while the title is empty. */
export function parseTodoCommand(text: string, bots: readonly TodoCommandBot[], now: Date = new Date()): TodoCommandDraft | null {
  const body = COMMAND.exec(text.trimStart())?.[1];
  if (body === undefined) return null;
  const { rest, botId } = takeBot(body, bots);
  const words = rest.split(/\s+/).filter(Boolean);
  const when = takeWhen(words, now);
  const titleWords = when && when.words.length > 0 ? when.words : words;
  const title = titleWords.join(" ").slice(0, TODO_TITLE_CHARS).trim();
  if (!title) return null;
  const used = when && when.words.length > 0 ? when : null;
  return { title, ...(botId ? { botId } : {}), start: used?.start ?? { kind: "free" }, ...(used?.repeat ? { repeat: used.repeat } : {}) };
}
