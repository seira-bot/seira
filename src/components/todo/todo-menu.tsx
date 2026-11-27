import { ListTodo } from "lucide-react";

import { splitTranscriptCitations } from "@/lib/citations";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";
import { ui } from "@/lib/ui-anchor";
import { ACTION_ICON, type MessageMenuItem } from "../MessageActions";
import { openTodoDialog } from "./todo-dialog-state";
import { todoSeed } from "./todo-seed";

export const TODO_MENU_KEYS: readonly string[] = ["todo-selection", "todo-message"];

export interface TodoMenuSource {
  threadId: string;
  /** The bot whose conversation it is: the dialog starts with it. Absent in a room. */
  botId?: string;
  groupId?: string;
  /** The speaker, as the source line names it. Absent: the person. */
  who?: string;
  at: number;
  /** The person's own line: its attachments and citations are not text. */
  user: boolean;
}

function displayText(text: string, user: boolean): string {
  return user ? splitTranscriptAttachments(splitTranscriptCitations(text).display).display : text;
}

/** "Make a todo from selection" (only while some text of the message is selected) and "Make a todo from message". */
export function todoMenuItems(text: string, messageId: string, source: TodoMenuSource | undefined): MessageMenuItem[] {
  if (!source || messageId.startsWith("optimistic-")) return [];
  const open = (selection?: string) => {
    const seed = todoSeed(displayText(text, source.user), selection);
    openTodoDialog({
      title: seed.title,
      note: seed.note,
      botId: source.botId ?? null,
      who: source.who ?? t("chat.todo.you"),
      at: source.at,
      source: {
        threadId: source.threadId, messageId,
        ...(source.groupId ? { groupId: source.groupId } : source.botId ? { botId: source.botId } : {}),
        ...(seed.quote ? { quote: seed.quote } : {}),
      },
    });
  };
  return [
    { key: TODO_MENU_KEYS[0]!, icon: <ListTodo {...ACTION_ICON} />, label: t("chat.todo.menuSelection"), selectionOnly: true, ui: ui("message.todo-selection"), onSelect: (selection) => open(selection) },
    { key: TODO_MENU_KEYS[1]!, icon: <ListTodo {...ACTION_ICON} />, label: t("chat.todo.menuMessage"), ui: ui("message.todo-message"), onSelect: () => open() },
  ];
}
