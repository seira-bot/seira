// The "Tasks I could help with" card on a bot line: one row per open task with Hide and Start. A hidden task shows
// Undo in this view only, a started task shows a receipt. The server's answer updates the card at once.
import { useState } from "react";
import { Bell, BarChart3, CalendarDays, FileText, ListChecks, Lightbulb, Loader2, Mail, MessageSquare, Search, type LucideIcon } from "lucide-react";

import type { TaskSuggestion, TaskSuggestionAction, TaskSuggestionsCard as TaskSuggestionsData } from "../../packages/phone-protocol/src/task-suggestions";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, type Message } from "@/state/store";
import { ASK_PRIMARY_BUTTON, ASK_QUIET_BUTTON } from "./AskCard";

const ICONS: Record<string, LucideIcon> = {
  idea: Lightbulb,
  mail: Mail,
  calendar: CalendarDays,
  document: FileText,
  search: Search,
  chart: BarChart3,
  reminder: Bell,
  message: MessageSquare,
  task: ListChecks,
};

export function taskSuggestionIcon(name: string): LucideIcon {
  return Object.hasOwn(ICONS, name) ? ICONS[name]! : Lightbulb;
}

function cardOf(line: unknown): TaskSuggestionsData | undefined {
  const card = (line as { taskSuggestions?: TaskSuggestionsData } | null | undefined)?.taskSuggestions;
  return card && Array.isArray(card.suggestions) ? card : undefined;
}

export function TaskSuggestionsCard({ botId, threadId, message, viewOnly }: { botId: string; threadId?: string; message: Message; viewOnly?: boolean }) {
  const shown = message.taskSuggestions;
  const [local, setLocal] = useState<{ from: unknown; card: TaskSuggestionsData } | null>(null);
  const [undoable, setUndoable] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const card = local && local.from === shown ? local.card : shown;
  if (!card) return null;

  const send = async (suggestion: TaskSuggestion, action: TaskSuggestionAction) => {
    if (busy || viewOnly || !threadId) return;
    setPending(suggestion.id);
    setError(null);
    try {
      const answer = await api<{ message?: unknown }>(`/api/bots/${encodeURIComponent(botId)}/task-suggestions`, {
        method: "POST",
        body: JSON.stringify({ threadId, messageId: message.id, suggestionId: suggestion.id, action }),
      });
      const next = cardOf(answer?.message);
      if (next) setLocal({ from: shown, card: next });
      if (action === "hide") setUndoable((ids) => [...ids.filter((id) => id !== suggestion.id), suggestion.id]);
      else setUndoable((ids) => ids.filter((id) => id !== suggestion.id));
    } catch (cause) {
      const current = cause instanceof Error ? cardOf((cause as { body?: { message?: unknown } }).body?.message) : undefined;
      if (current) setLocal({ from: shown, card: current });
      setError(cause instanceof Error && cause.message ? cause.message : t("chat.taskSuggestions.failed"));
    } finally {
      setPending(null);
    }
  };

  const rows = card.suggestions.flatMap((suggestion) => {
    if (suggestion.state === "hidden" && !undoable.includes(suggestion.id)) return [];
    return [suggestion];
  });
  if (!rows.length) return null;

  return (
    <div data-task-suggestions className="max-w-[600px] text-[15px] leading-relaxed text-ink">
      <p dir="auto" className="mb-1 font-medium">{card.intro || t("chat.taskSuggestions.title")}</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map((suggestion) => {
          const Icon = taskSuggestionIcon(suggestion.icon);
          if (suggestion.state === "hidden") {
            return (
              <li key={suggestion.id} data-task-suggestion={suggestion.id} data-state="hidden" className="flex flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
                <span dir="auto">{t("chat.taskSuggestions.hidden")}</span>
                <button
                  type="button"
                  aria-label={t("chat.taskSuggestions.undoLabel", { title: suggestion.title })}
                  disabled={busy || viewOnly}
                  onClick={() => void send(suggestion, "show")}
                  className={cn(ASK_QUIET_BUTTON, "my-0")}
                >
                  {t("chat.taskSuggestions.undo")}
                </button>
              </li>
            );
          }
          return (
            <li key={suggestion.id} data-task-suggestion={suggestion.id} data-state={suggestion.state} className="flex flex-wrap items-start gap-x-2 gap-y-1">
              <Icon size={16} aria-hidden="true" className="mt-1 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <p dir="auto" className="font-medium">{suggestion.title}</p>
                {suggestion.description && <p dir="auto" className="text-[13px] text-ink-secondary">{suggestion.description}</p>}
              </div>
              {suggestion.state === "started" ? (
                <span className="mt-0.5 text-[12px] text-ink-tertiary">{t("chat.taskSuggestions.started")}</span>
              ) : (
                !viewOnly && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={t("chat.taskSuggestions.hideLabel", { title: suggestion.title })}
                      data-testid="task-suggestion-hide"
                      disabled={busy}
                      onClick={() => void send(suggestion, "hide")}
                      className={cn(ASK_QUIET_BUTTON, "my-0")}
                    >
                      {t("chat.taskSuggestions.hide")}
                    </button>
                    <button
                      type="button"
                      aria-label={t("chat.taskSuggestions.startLabel", { title: suggestion.title })}
                      data-testid="task-suggestion-start"
                      disabled={busy}
                      onClick={() => void send(suggestion, "start")}
                      className={ASK_PRIMARY_BUTTON}
                    >
                      {pending === suggestion.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : t("chat.taskSuggestions.start")}
                    </button>
                  </div>
                )
              )}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
