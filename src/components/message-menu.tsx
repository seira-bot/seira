import { BookmarkPlus, Code, Copy, Eye, Pencil, Pin, PinOff, RefreshCw, Reply, Square, Volume2 } from "lucide-react";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { ui } from "@/lib/ui-anchor";
import { useContext, type Dispatch } from "react";
import type { Action, ConfigStatus, Group, Message, useStore } from "@/state/store";
import { ACTION_ICON, type MessageMenuItem } from "@/components/MessageActions";
import { drawWorkflowItem, finishedReply } from "@/components/workflow/draw-workflow";
import { useWorkflowsUnavailable } from "@/state/workflows";
import { useSpeakAction } from "@/components/SpeakButton";
import { openConversationDialog, TEAM_MEMORY_ITEM, TeamMemorySavesContext } from "@/components/conversation-share/conversation-share";
import { TODO_MENU_KEYS, todoMenuItems, type TodoMenuSource } from "@/components/todo/todo-menu";

export type PinAction = { pinned: boolean; onToggle: () => void; hint?: string };

export function replyAndCopy(onReply: () => void, text: string): MessageMenuItem[] {
  return [
    { key: "reply", icon: <Reply {...ACTION_ICON} />, label: t("chat.reply"), onSelect: onReply },
    ...(text.trim() ? [{ key: "copy", icon: <Copy {...ACTION_ICON} />, label: t("chat.copyMessage"), onSelect: () => { void copyText(text); } }] : []),
  ];
}

export function roomPin(group: Group, message: Message, dispatch: ReturnType<typeof useStore>["dispatch"]): PinAction | undefined {
  if (window.ogb?.remoteClient?.active) return undefined;
  const pinned = group.pinnedMessageId === message.id;
  return {
    pinned,
    hint: t("room.pinHint"),
    onToggle: () => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: pinned ? "" : message.id } }),
  };
}

function pinItem(pin: PinAction | undefined): MessageMenuItem[] {
  if (!pin) return [];
  return [{
    key: "pin",
    icon: pin.pinned ? <PinOff {...ACTION_ICON} /> : <Pin {...ACTION_ICON} />,
    label: pin.pinned ? t("chat.unpinMessage") : t("chat.pinMessage"),
    title: pin.pinned ? t("chat.unpinHint") : pin.hint ?? t("chat.pinHint"),
    onSelect: pin.onToggle,
  }];
}

function idItem(messageId: string): MessageMenuItem {
  return { key: "copy-id", icon: <Copy {...ACTION_ICON} />, label: t("chat.copyMessageId"), onSelect: () => { void copyText(messageId); } };
}

/** "Save to team memory" on a message of a team bot's conversation; nothing in a group chat or off a team. */
function useTeamMemoryItem(text: string, messageId: string, botId?: string, threadId?: string): MessageMenuItem[] {
  const offered = useContext(TeamMemorySavesContext);
  if (!offered || !botId || !threadId || !text.trim() || messageId.startsWith("optimistic-")) return [];
  return [{ key: TEAM_MEMORY_ITEM, icon: <BookmarkPlus {...ACTION_ICON} />, label: t("teamMemorySave.menu"),
    onSelect: () => openConversationDialog({ kind: "memory", botId, threadId, messageId, text }) }];
}

export function useBotMessageMenu({
  text,
  botId,
  threadId,
  messageId,
  voiceId,
  tts,
  localVoice,
  canSpeak,
  viewRaw,
  onToggleRaw,
  onRegenerate,
  pin,
  draw,
  todo,
}: {
  text: string;
  botId?: string;
  /** The bot's conversation the message is in; a group chat names none. */
  threadId?: string;
  messageId: string;
  voiceId?: string;
  tts: ConfigStatus["tts"];
  localVoice: boolean;
  canSpeak: boolean;
  viewRaw: boolean;
  onToggleRaw: () => void;
  onRegenerate?: () => void;
  pin?: PinAction;
  /** Offers "Draw as workflow" on a finished reply. */
  draw?: { threadId: string; reply: Message; dispatch: Dispatch<Action> };
  /** Offers the todo rows; names the conversation the message is in. */
  todo?: TodoMenuSource;
}): MessageMenuItem[] {
  const workflowsOff = useWorkflowsUnavailable();
  const speak = useSpeakAction({ text, botId, messageId, voiceId, tts, localVoice });
  const teamMemory = useTeamMemoryItem(text, messageId, botId, threadId);
  const items: MessageMenuItem[] = [];
  // Once a voice is set up, Read this aloud is its own button in the hover bar; the menu keeps only the setup hint.
  if (canSpeak && text && !speak.ready) {
    items.push({
      key: "speak",
      icon: speak.mine ? <Square {...ACTION_ICON} /> : <Volume2 {...ACTION_ICON} />,
      label: speak.mine ? t("chat.speak.stop") : t("chat.speak.read"),
      title: speak.label,
      disabled: !speak.ready,
      onSelect: speak.toggle,
    });
  }
  if (text) {
    items.push({
      key: "raw",
      icon: viewRaw ? <Eye {...ACTION_ICON} /> : <Code {...ACTION_ICON} />,
      label: t(viewRaw ? "chat.showRenderedMarkdown" : "chat.showRawMarkdown"),
      onSelect: onToggleRaw,
    });
  }
  if (onRegenerate) items.push({ key: "regenerate", icon: <RefreshCw {...ACTION_ICON} />, label: t("chat.regenerate"), onSelect: onRegenerate, ui: ui("message.regenerate") });
  if (draw && !workflowsOff && finishedReply(draw.reply)) items.push(drawWorkflowItem(draw));
  items.push(...todoMenuItems(text, messageId, todo), ...teamMemory, ...pinItem(pin), idItem(messageId));
  return items;
}

/** The rows of the bot menu's hook that a person's line offers too: team memory and the todo rows. */
export const userSaveItems = (menu: readonly MessageMenuItem[]): MessageMenuItem[] =>
  menu.filter((item) => item.key === TEAM_MEMORY_ITEM || TODO_MENU_KEYS.includes(item.key));

/** `save`: the message's "Save to team memory" and todo rows, as the bot menu's hook made them. */
export function userMessageMenu({ messageId, onEdit, pin, save = [] }: { messageId: string; onEdit?: () => void; pin?: PinAction; save?: MessageMenuItem[] }): MessageMenuItem[] {
  return [
    ...(onEdit ? [{ key: "edit", icon: <Pencil {...ACTION_ICON} />, label: t("chat.editMessage"), onSelect: onEdit, idleOnly: true }] : []),
    ...save,
    ...pinItem(pin),
    idItem(messageId),
  ];
}
