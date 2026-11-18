import { useEffect, useRef, useState } from "react";
import { Check, CornerUpLeft, ExternalLink, Split, X, type LucideIcon } from "lucide-react";
import type { InboxRow } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { settleInboxRow } from "@/state/inbox";
import type { LocaleKey } from "@/locales";
import { InboxSender } from "../InboxLine";
import { threadUpdatedLabel } from "../SidebarThreadRow";
import { choicesLine, headlineOf, snippetOf } from "./inbox-answer";
import { placeOf, quickActions, senderLabel, subjectOf, textOf, type QuickAction } from "./inbox-view";

const ACTION_LOOK: Record<QuickAction, { Icon: LucideIcon; label: LocaleKey }> = {
  allow: { Icon: Check, label: "approval.action.allowOnce" },
  deny: { Icon: X, label: "approval.action.deny" },
  reply: { Icon: CornerUpLeft, label: "chat.reply" },
  close: { Icon: Check, label: "common.done" },
  done: { Icon: Check, label: "common.done" },
  open: { Icon: ExternalLink, label: "inbox.action.openInChat" },
};

const EXIT_MS = 200;

const ROW_ACTION = "flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink active:bg-ink/[0.11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:size-9";

export function InboxRowItem({ row, now, onOpen, onAction, inCard = false }: {
  row: InboxRow;
  now: number;
  onOpen(row: InboxRow): void;
  onAction(row: InboxRow, action: QuickAction, failed?: () => void): void;
  /** On the inbox's card in the chat, which is wider than the panel and draws its own dividers. */
  inCard?: boolean;
}) {
  const subject = subjectOf(row);
  const actions = quickActions(row);
  const sender = senderLabel(row);
  const place = placeOf(row);
  const headline = inCard ? "" : headlineOf(row);
  const choices = inCard ? null : choicesLine(row);
  const snippet = inCard || choices ? null : snippetOf(row);
  const unreadish = row.unread || row.tab === "needs-you";
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const act = (action: QuickAction) => {
    if (inCard || action === "open" || action === "reply") { onAction(row, action); return; }
    setLeaving(true);
    timer.current = setTimeout(() => {
      onAction(row, action, () => setLeaving(false));
      if (action === "allow" || action === "deny" || action === "close") settleInboxRow(row);
    }, EXIT_MS);
  };
  return (
    <div data-inbox-row={row.id} data-tab={row.tab} data-unread={row.unread ? "" : undefined}
      className={cn("group relative flex min-w-0 pr-1.5 focus-within:bg-raised/70 hover:bg-raised/70",
        inCard ? cn("items-center gap-2", row.unread ? "bg-raised/45" : "bg-transparent")
          : cn("flex-col gap-2.5 rounded-xl p-3 pr-3 ring-1 ring-inset ring-ink/[0.07] transition-[translate,opacity,background-color] duration-200 motion-reduce:transition-none",
            leaving && "translate-x-4 opacity-0 rtl:-translate-x-4"))}
      inert={leaving || undefined}>
      <button type="button" onClick={() => onOpen(row)} title={[sender, inCard ? subject : headline, place].filter(Boolean).join(" · ")}
        className={cn("flex min-w-0 flex-1 gap-2 pl-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60", inCard ? "items-center py-1.5" : "items-start gap-3 pl-0",
          row.unread ? "font-semibold text-ink" : "font-normal text-ink-secondary")}>
        {row.tab === "needs-you" ? <span data-inbox-waits className={cn("size-1.5 shrink-0 rounded-full", inCard ? "bg-warning" : "mt-[7px] bg-accent")} role="img" aria-label={t("inbox.waitsOnYou")} />
          : !inCard && <span data-inbox-unread-dot={row.unread ? "" : undefined} aria-hidden="true" className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", row.unread ? "bg-accent" : "hidden")} />}
        <span className="shrink-0" aria-hidden="true"><InboxSender from={row.from} size={inCard ? 20 : 36} /></span>
        {inCard ? (
          <>
            <span className="w-[7.5rem] shrink-0 truncate">{row.from.name}</span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="max-w-[45%] shrink-0 truncate">{subject}</span>
              <span className="min-w-0 truncate font-normal text-ink-tertiary">{textOf(row)}</span>
            </span>
            <span className="shrink-0 text-[11px] font-normal tabular-nums text-ink-tertiary group-focus-within:invisible group-hover:invisible">{threadUpdatedLabel(row.at, now)}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 space-y-px">
            <span className="flex items-baseline gap-1.5">
              <span data-inbox-from className="min-w-0 shrink truncate font-medium">{sender}</span>
              {place && <span data-inbox-place className="min-w-0 flex-1 truncate text-[12px] font-normal text-ink-tertiary">{place}</span>}
              <span className="ms-auto shrink-0 ps-1 text-[11px] font-normal tabular-nums text-ink-tertiary group-focus-within:invisible group-hover:invisible">{threadUpdatedLabel(row.at, now)}</span>
            </span>
            <span data-inbox-subject className={cn("block truncate text-[13px] font-medium", unreadish ? "text-ink" : "text-ink-secondary")}>{headline}</span>
            {choices ? (
              <span data-inbox-choices className="flex min-w-0 items-center gap-1.5 text-[12px] font-normal text-ink-secondary">
                <Split size={12} aria-hidden="true" className="shrink-0 rotate-180 text-warning" />
                <span className="min-w-0 truncate">{choices}</span>
              </span>
            ) : snippet && <span className="line-clamp-2 text-[12px] font-normal leading-4 text-ink-tertiary">{snippet}</span>}
          </span>
        )}
      </button>
      {inCard ? (
        <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-raised group-focus-within:flex group-hover:flex">
          {actions.map((action) => {
            const { Icon, label } = ACTION_LOOK[action];
            return (
              <button key={action} type="button" data-inbox-action={action} aria-label={t(label)} title={t(label)} onClick={() => act(action)} className={ROW_ACTION}>
                <Icon size={14} aria-hidden="true" />
              </button>
            );
          })}
        </span>
      ) : (
        <span data-inbox-actions className="flex flex-wrap gap-1.5 ps-12">
          {actions.map((action, index) => {
            const { Icon, label } = ACTION_LOOK[action];
            return (
              <button key={action} type="button" data-inbox-action={action} onClick={() => act(action)}
                className={cn("ui-button ui-button-md ui-button-pill", index === 0 && "ui-button-primary")}>
                <Icon size={13} aria-hidden="true" />{t(label)}
              </button>
            );
          })}
        </span>
      )}
    </div>
  );
}
