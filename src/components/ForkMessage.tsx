import { GitFork } from "lucide-react";
import { memo, type Dispatch } from "react";
import { ACTION_ICON, type MessageMenuItem } from "./MessageActions";
import { t } from "@/lib/i18n";
import type { Action } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";

type Owner = { kind: "bot" | "group"; ownerId: string; threadId: string; messageId: string };

export function forkMessageItem(owner: Owner, dispatch: Dispatch<Action>, disabled: boolean): MessageMenuItem {
  return {
    key: "fork-conversation",
    icon: <GitFork {...ACTION_ICON} />,
    label: t("chat.forkConversation"),
    disabled,
    onSelect: () => dispatch({ type: "forkMessage", ...owner }),
  };
}

type ForkLink = { threadId: string; title: string };

const NO_FORKS: readonly ForkLink[] = [];

const sameForks = (a: readonly ForkLink[], b: readonly ForkLink[]) =>
  a.length === b.length && a.every((fork, index) => fork.threadId === b[index]!.threadId && fork.title === b[index]!.title);

export const ForkLinks = memo(function ForkLinks(owner: Owner & { phone: boolean }) {
  const dispatch = useStoreDispatch();
  const forks = useStoreSelector((state) => {
    const tasks = owner.kind === "bot"
      ? state.bots?.find((bot) => bot.id === owner.ownerId)?.tasks
      : state.groups?.find((group) => group.id === owner.ownerId)?.tasks;
    const found = tasks?.filter((task) => task.origin?.threadId === owner.threadId && task.origin.messageId === owner.messageId)
      .map((task) => ({ threadId: task.threadId, title: task.title }));
    return found?.length ? found : NO_FORKS;
  }, sameForks);
  if (owner.phone || !forks.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="fork-links">
      {forks.map((fork) => (
        <button key={fork.threadId} type="button"
          className="rounded-full border border-hairline px-2 py-0.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
          onClick={() => dispatch({ type: "openForkPanel", kind: owner.kind, ownerId: owner.ownerId, threadId: fork.threadId })}>
          <GitFork size={12} className="mr-1 inline" />{t("chat.openFork", { title: fork.title })}
        </button>
      ))}
    </div>
  );
});
