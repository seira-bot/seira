import { MoreHorizontal } from "lucide-react";
import type { InboxView } from "../../../shared/inbox";
import { t } from "@/lib/i18n";
import { requestInboxSummary, setInboxSummarizer } from "@/state/inbox";
import { useStore } from "@/state/store";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../SidebarPopoverMenu";
import { roundButtonCls } from "../bot-panel/rows";
import { isNews } from "./inbox-kind";

/** The Inbox's options: write the summary now, and pick who writes it or turn it off. Only where a summary is written. */
export function InboxMenu({ view }: { view: InboxView }) {
  const { state } = useStore();
  const writer = view.summarizer;
  if (!writer) return null;
  const few = view.rows.filter(isNews).length < 2;
  const items: SidebarMenuItem[] = [
    { key: "summarize", label: t("inbox.menu.summarizeNow"), disabled: few, ...(few ? { subtitle: t("inbox.menu.summarizeNeedsMore") } : {}), onSelect: () => void requestInboxSummary(true) },
    ...state.bots.filter((bot) => !bot.hidden).map((bot, index): SidebarMenuItem => ({
      key: `writer-${bot.id}`, label: bot.name, checked: writer.botId === bot.id, ...(index === 0 ? { heading: t("inbox.menu.writer"), separatorBefore: true } : {}), onSelect: () => void setInboxSummarizer(bot.id),
    })),
    { key: "writer-off", label: t("inbox.menu.off"), checked: writer.botId === null, onSelect: () => void setInboxSummarizer(null) },
  ];
  return (
    <SidebarPopoverMenu items={items} ariaLabel={t("inbox.menu.label")} placement="below" align="end" triggerClassName="shrink-0 rounded-full" triggerTitle={t("inbox.menu.label")}
      renderTrigger={() => <span data-inbox-menu className={roundButtonCls}><MoreHorizontal size={16} aria-hidden="true" /></span>} />
  );
}
