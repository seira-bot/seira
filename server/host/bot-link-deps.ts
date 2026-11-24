import { dirname } from "node:path";

import type { BotLinkDeps } from "../bot-link/link.ts";
import type { HandoffView } from "../coordinator.ts";
import { redactSecretsInText } from "../redact.ts";
import type { Level } from "../runtime/types.ts";
import type { BotRecord, Store } from "../store.ts";
import type { HandoffFiles, PassedFile } from "./handoff-files.ts";
import { sentRow, teammateResultRow } from "./handoff-sent.ts";

export interface BotLinkStoreDeps {
  store: Pick<Store, "bots" | "bot" | "createTask" | "taskByThread" | "appendMessage" | "patchTask" | "group" | "groupTaskByThread" | "markGroupThreadUnread">;
  level(bot: BotRecord): Level;
  refusal(bot: BotRecord): string | null;
  language(threadId: string): string | undefined;
  personName(threadId: string): string | undefined;
  files: Pick<HandoffFiles, "carried" | "crossed" | "sentWith" | "returnedWith">;
  /** One crossed file into the attachment store, named by its bytes, under attach_file's own type and size rules. */
  storeFile(path: string, name: string, root: string): Promise<{ attachment: { kind: string; path: string; mime: string; name?: string }; bytes: number }>;
}

export type SharedLinkDeps = Pick<BotLinkDeps, "bots" | "bot" | "refusal" | "model" | "level" | "openThread" | "hasThread" | "personName" | "sentRow" | "resultRow">
  & { files: Omit<NonNullable<BotLinkDeps["files"]>, "discard"> };

/** What every bot link of this server reads from and writes to the store: the person's own link and each linked server's. */
export function botLinkDeps(deps: BotLinkStoreDeps): SharedLinkDeps {
  const { store } = deps;
  return {
    bots: () => store.bots, bot: (id) => store.bot(id),
    refusal: (bot) => deps.refusal(bot as BotRecord),
    model: (bot) => (bot as BotRecord).modelSelection.model,
    level: (bot) => deps.level(bot as BotRecord),
    openThread: (bot, title, opener) => store.createTask(bot.id, title, false, undefined, { ...opener, at: Date.now(), kind: "work" })?.threadId,
    hasThread: (botId, threadId) => Boolean(store.taskByThread(botId, threadId)),
    personName: deps.personName,
    files: {
      carried: deps.files.carried, crossed: deps.files.crossed,
      store: async (files) => {
        const stored: PassedFile[] = [];
        for (const file of files) {
          const { attachment, bytes } = await deps.storeFile(file.path, file.name, dirname(file.path));
          if (attachment.kind === "image" || attachment.kind === "file") stored.push({ kind: attachment.kind, path: attachment.path, name: attachment.name || file.name, mime: attachment.mime, bytes });
        }
        return stored;
      },
    },
    sentRow: ({ sender, threadId, recipient, workThreadId, nodeId, reason, doneWhen, roomId }) => {
      const room = roomId ? store.group(roomId) : undefined;
      store.appendMessage(threadId, sentRow({ sender: { id: sender.id, name: sender.name, color: sender.color ?? "blue" }, recipient: { ...recipient, color: "blue" }, threadId: workThreadId, via: "direct", language: deps.language(threadId), ...(room ? { room: { id: room.id, name: room.name, here: true } } : {}),
        ...(reason ? { reason } : {}), ...(doneWhen ? { doneWhen: redactSecretsInText(doneWhen) } : {}), ...deps.files.sentWith(nodeId) }));
    },
    resultRow: (parent: HandoffView, child: HandoffView, name: string) => {
      const room = parent.groupId ? store.group(parent.groupId) : undefined;
      if (parent.groupId ? !room || !store.groupTaskByThread(room.id, parent.threadId) : !store.taskByThread(parent.botId, parent.threadId)) return;
      const done = child.status === "completed";
      store.appendMessage(parent.threadId, { role: "bot", kind: "activity", roomRequest: { id: child.id, phase: "result" }, ...deps.files.returnedWith(child, parent),
        tool: { name: teammateResultRow(deps.language(parent.threadId), child, name, undefined, undefined), ok: done,
          ...(done && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) } });
      if (room) store.markGroupThreadUnread(room.id, parent.threadId, true);
      else if (!parent.parentId && parent.reply !== "poll") store.patchTask(parent.botId, parent.threadId, { unread: true });
    },
  };
}
