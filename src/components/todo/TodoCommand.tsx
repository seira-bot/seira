import { useMemo, useRef, type ReactNode } from "react";
import { ListTodo } from "lucide-react";

import { isTodoCommand, parseTodoCommand } from "../../../shared/todo-command";
import { t } from "@/lib/i18n";
import { showToast } from "@/lib/power";
import { todoWhenLabel } from "@/lib/todo-labels";
import { ui } from "@/lib/ui-anchor";
import type { ComposerSlashCommand } from "@/lib/composer-commands";
import type { Bot } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import { addTodos } from "@/state/todos";
import { announceTodosAdded } from "./todo-toast";

export function todoSlashCommand(): ComposerSlashCommand {
  return { kind: "command", id: "todo", label: "/todo", description: t("composer.command.todoDesc") };
}

/** `/todo <title> [@bot] [when]` in the composer: a preview row above the box, and Enter adds the todo instead of sending a message. */
export function useTodoCommand({ text, bots, botId, groupId, threadId, onDone }: {
  text: string;
  bots: readonly Bot[];
  /** The bot of a one-on-one chat; the todo goes to it unless the text names another. */
  botId?: string;
  groupId?: string;
  threadId: string;
  /** The todo was added: the composer clears. */
  onDone: () => void;
}): { preview: ReactNode; run: () => boolean } {
  const dispatch = useStoreDispatch();
  const active = isTodoCommand(text);
  const named = useMemo(() => bots.filter((bot) => !bot.hidden), [bots]);
  const draft = useMemo(() => active ? parseTodoCommand(text, named) : null, [active, text, named]);
  const pending = useRef(false);
  const target = draft ? draft.botId ?? botId : undefined;
  const targetName = named.find((bot) => bot.id === target)?.name;

  const add = async () => {
    if (!draft || pending.current) return;
    pending.current = true;
    try {
      const made = await addTodos([{
        title: draft.title,
        ...(target ? { botId: target } : {}),
        start: draft.start,
        ...(draft.repeat ? { repeat: draft.repeat } : {}),
        source: { threadId, ...(groupId ? { groupId } : botId ? { botId } : {}) },
      }]);
      onDone();
      announceTodosAdded(made, targetName ?? null, dispatch);
    } catch {
      showToast(t("chat.todo.failed"));
    } finally {
      pending.current = false;
    }
  };

  const when = draft ? todoWhenLabel(draft, () => undefined) : "";
  const preview = draft && (
    <div data-todo-command-preview="" role="group" aria-label={t("composer.todo.preview")}
      className="mb-2 flex items-center gap-2 rounded-xl bg-inset px-3 py-2 text-[13px] shadow-[inset_0_0_0_0.5px_var(--color-edge)]">
      <ListTodo size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <span dir="auto" className="min-w-0 flex-1 truncate">
        <span className="text-ink">{draft.title}</span>
        <span className="text-ink-secondary"> · {t("composer.todo.for", { bot: targetName ?? t("todo.fields.anyBot") })} · {when}</span>
      </span>
      <button type="button" data-ui={ui("composer.todo-add")} onClick={() => void add()}
        className="ui-button ui-button-pill ui-button-sm shrink-0 border-transparent bg-ink text-app hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {t("composer.todo.add")}
      </button>
    </div>
  );

  return { preview, run: () => { if (!active) return false; void add(); return true; } };
}
