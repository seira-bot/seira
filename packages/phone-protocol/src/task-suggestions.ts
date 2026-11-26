// The "Tasks I could help with" card on a bot line: short tasks the bot offers to do, each with Hide and Start. Start sends
// the shown title as the person's own line, as a typed message would, so the card grants nothing a person could not type.
// The server and every client read the same shape and the same state rules from this module.
import { cleanPlainLine } from "./suggested-replies.ts";

export const TASK_SUGGESTIONS_MAX = 5;
export const TASK_SUGGESTION_TITLE_MAX = 80;
export const TASK_SUGGESTION_DESCRIPTION_MAX = 240;
export const TASK_SUGGESTIONS_INTRO_MAX = 200;
/** How many entries of a list are read at most, so a huge list costs a bounded amount of work. */
const TASK_SUGGESTIONS_READ = 16;

/** The icon names a card may carry. A client draws "idea" for a name it does not know. */
export const TASK_SUGGESTION_ICONS = ["idea", "mail", "calendar", "document", "search", "chart", "reminder", "message", "task"] as const;
export type TaskSuggestionIcon = (typeof TASK_SUGGESTION_ICONS)[number];
export const DEFAULT_TASK_SUGGESTION_ICON: TaskSuggestionIcon = "idea";

/** `open`: Hide and Start are offered. `hidden`: the person hid it; Show brings it back. `started`: the title was sent; final. */
export type TaskSuggestionState = "open" | "hidden" | "started";
/** What a person can do with one suggestion. `show` undoes a hide. */
export type TaskSuggestionAction = "start" | "hide" | "show";
export const TASK_SUGGESTION_ACTIONS: readonly TaskSuggestionAction[] = ["start", "hide", "show"];

export interface TaskSuggestion {
  /** Stable within its card: `s1` to `s5`. */
  id: string;
  title: string;
  description?: string;
  icon: TaskSuggestionIcon;
  state: TaskSuggestionState;
  /** The person's line that Start sent, once it is stored in the chat. Absent while that line waits for a busy bot. */
  startedMessageId?: string;
  /** ISO time of the last Start, Hide or Show. */
  changedAt?: string;
}

export interface TaskSuggestionsCard {
  /** The bot's lead-in, such as "Tasks I could help with:". Absent: the client shows its own heading. */
  intro?: string;
  suggestions: TaskSuggestion[];
}

export interface TaskSuggestionsField {
  /** The card on a bot line. The line's `text` lists the same tasks for a client that does not draw the card. */
  taskSuggestions?: TaskSuggestionsCard;
  /** On the person's line that Start sent: the card line and the suggestion it came from. */
  fromTaskSuggestion?: { messageId: string; suggestionId: string };
}

/** The card a bot asks for: at most 5 entries, each with a plain title of at most 80 characters, an optional plain description
 * of at most 240, and a known icon. An entry with an empty, over-limit or unsafe title is dropped whole; an unsafe or over-limit
 * description or intro is left out. Repeated titles count once. `null` when no entry is left. */
export function parseTaskSuggestionsInput(value: unknown): TaskSuggestionsCard | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as { intro?: unknown; tasks?: unknown };
  if (!Array.isArray(input.tasks)) return null;
  const suggestions: TaskSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of input.tasks.slice(0, TASK_SUGGESTIONS_READ)) {
    if (suggestions.length === TASK_SUGGESTIONS_MAX) break;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const raw = entry as { title?: unknown; description?: unknown; icon?: unknown };
    const title = cleanPlainLine(raw.title, TASK_SUGGESTION_TITLE_MAX);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const description = cleanPlainLine(raw.description, TASK_SUGGESTION_DESCRIPTION_MAX);
    suggestions.push({
      id: `s${suggestions.length + 1}`,
      title,
      ...(description ? { description } : {}),
      icon: taskSuggestionIcon(raw.icon),
      state: "open",
    });
  }
  if (!suggestions.length) return null;
  const intro = cleanPlainLine(input.intro, TASK_SUGGESTIONS_INTRO_MAX);
  return { ...(intro ? { intro } : {}), suggestions };
}

/** A known icon name, or "idea". */
export function taskSuggestionIcon(value: unknown): TaskSuggestionIcon {
  return typeof value === "string" && (TASK_SUGGESTION_ICONS as readonly string[]).includes(value) ? (value as TaskSuggestionIcon) : DEFAULT_TASK_SUGGESTION_ICON;
}

/** The line's readable text: the intro (else `heading`, in the person's language), then one bullet per task. */
export function taskSuggestionsText(card: TaskSuggestionsCard, heading: string): string {
  const lines = card.suggestions.map((suggestion) => `- ${suggestion.title}${suggestion.description ? `: ${suggestion.description}` : ""}`);
  return [card.intro ?? heading, ...lines].join("\n");
}

/** What an action does to a suggestion in `current` state. `same`: nothing changes and the answer is still a success.
 * `refused`: the action does not apply, such as Start on a hidden or started suggestion. */
export type TaskSuggestionStep = { kind: "change"; state: TaskSuggestionState } | { kind: "same" } | { kind: "refused" };

export function nextTaskSuggestionState(current: TaskSuggestionState, action: TaskSuggestionAction): TaskSuggestionStep {
  if (action === "start") return current === "open" ? { kind: "change", state: "started" } : { kind: "refused" };
  if (action === "hide") {
    if (current === "open") return { kind: "change", state: "hidden" };
    return current === "hidden" ? { kind: "same" } : { kind: "refused" };
  }
  if (current === "hidden") return { kind: "change", state: "open" };
  return current === "open" ? { kind: "same" } : { kind: "refused" };
}
