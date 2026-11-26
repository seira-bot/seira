// The "Tasks I could help with" card on a bot line (packages/phone-protocol/src/task-suggestions.ts): the bot posts it, the
// person starts or hides a task, and the state lives on the stored line so every client reads the same answer.
import {
  nextTaskSuggestionState,
  parseTaskSuggestionsInput,
  taskSuggestionsText,
  type TaskSuggestionAction,
  type TaskSuggestionsCard,
} from "../packages/phone-protocol/src/task-suggestions.ts";
import { redactSecretsInText } from "./redact.ts";
import { conversationLanguage, serverLine } from "./server-lines.ts";
import type { Message, Store } from "./store.ts";

type CardStore = Pick<Store, "patchMessage" | "messagesFor">;

/** The card a bot asked for, or null when no task is left. A task that holds a secret is dropped whole: redaction must never
 * change what Start would send. An intro that holds a secret is left out. */
export function taskSuggestionsFromInput(body: { intro?: unknown; tasks?: unknown } | null | undefined): TaskSuggestionsCard | null {
  const tasks = Array.isArray(body?.tasks)
    ? body.tasks.filter((task: unknown) => {
        if (typeof task !== "object" || task === null) return true;
        const { title, description } = task as { title?: unknown; description?: unknown };
        return [title, description].every((text) => typeof text !== "string" || redactSecretsInText(text) === text);
      })
    : body?.tasks;
  const intro = typeof body?.intro === "string" && redactSecretsInText(body.intro) !== body.intro ? undefined : body?.intro;
  return parseTaskSuggestionsInput({ intro, tasks });
}

export function postTaskSuggestions(store: Pick<Store, "appendMessage">, threadId: string, card: TaskSuggestionsCard): Message {
  return store.appendMessage(threadId, { role: "bot", kind: "text", text: taskSuggestionsText(card, serverLine(conversationLanguage(threadId), "server.taskSuggestions.heading")), taskSuggestions: card });
}

/** The card line `messageId` in `threadId`, and the index of suggestion `suggestionId` on it. */
export function findTaskSuggestion(store: Pick<Store, "messagesFor">, threadId: string, messageId: string, suggestionId: string): { message: Message; card: TaskSuggestionsCard; index: number } | null {
  const message = store.messagesFor(threadId).find((line) => line.id === messageId);
  const card = message?.taskSuggestions;
  const index = card ? card.suggestions.findIndex((suggestion) => suggestion.id === suggestionId) : -1;
  return message && card && index >= 0 ? { message, card, index } : null;
}

export type TaskSuggestionStep = { kind: "change"; message: Message } | { kind: "same"; message: Message } | { kind: "refused"; message: Message } | { kind: "missing" };

/** Moves one suggestion to the state `action` leads to and patches the stored line with a new card object. */
export function answerTaskSuggestion(store: CardStore, threadId: string, messageId: string, suggestionId: string, action: TaskSuggestionAction, extra: { startedMessageId?: string } = {}): TaskSuggestionStep {
  const found = findTaskSuggestion(store, threadId, messageId, suggestionId);
  if (!found) return { kind: "missing" };
  const suggestion = found.card.suggestions[found.index]!;
  const step = nextTaskSuggestionState(suggestion.state, action);
  if (step.kind !== "change") return { kind: step.kind, message: found.message };
  const changed = { ...suggestion, state: step.state, changedAt: new Date().toISOString(), ...(extra.startedMessageId ? { startedMessageId: extra.startedMessageId } : {}) };
  const card: TaskSuggestionsCard = { ...found.card, suggestions: found.card.suggestions.map((one, at) => (at === found.index ? changed : one)) };
  const patched = store.patchMessage(threadId, messageId, { taskSuggestions: card });
  return patched ? { kind: "change", message: patched } : { kind: "missing" };
}

/** One card per turn: remembers the turn generation that already posted one in a thread. */
export class TaskSuggestionTurns {
  readonly #posted = new Map<string, string>();

  /** True the first time a generation asks for a thread, false for every later ask in that generation. */
  claim(threadId: string, generation: string): boolean {
    if (this.#posted.get(threadId) === generation) return false;
    this.#posted.set(threadId, generation);
    return true;
  }

  /** Gives the claim back when the card was not stored. */
  release(threadId: string, generation: string): void {
    if (this.#posted.get(threadId) === generation) this.#posted.delete(threadId);
  }

  /** A turn starts or ends: nothing claimed before it counts. */
  clear(threadId: string): void {
    this.#posted.delete(threadId);
  }
}

export const TASK_SUGGESTIONS_NONE = "No task was kept: each needs a plain-text title within 80 characters, with no link, command or code.";

/** The bot's request for a card in its own thread. A room never takes one, and a turn posts one card at most. */
export function offerTaskSuggestions(
  deps: { store: Pick<Store, "appendMessage">; turns: TaskSuggestionTurns; isRoom(threadId: string): boolean; personStarted(threadId: string, generation: string): boolean },
  threadId: string,
  generation: string,
  body: { intro?: unknown; tasks?: unknown } | null | undefined,
): { status: number; body: Record<string, unknown> } {
  if (!deps.personStarted(threadId, generation)) return { status: 409, body: { error: "A task card is only for a turn that the person started. Write the tasks in your reply instead." } };
  if (deps.isRoom(threadId)) return { status: 409, body: { error: "A room does not take a task card. Write the tasks in your reply instead." } };
  const card = taskSuggestionsFromInput(body);
  if (!card) return { status: 400, body: { error: TASK_SUGGESTIONS_NONE } };
  if (!deps.turns.claim(threadId, generation)) return { status: 409, body: { error: "This turn already showed a task card. Show one card at most in a turn." } };
  try {
    const message = postTaskSuggestions(deps.store, threadId, card);
    return { status: 201, body: { ok: true, messageId: message.id, kept: card.suggestions.length } };
  } catch (error) {
    deps.turns.release(threadId, generation);
    throw error;
  }
}
