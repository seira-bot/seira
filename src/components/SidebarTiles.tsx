import { Crown, Loader2, Phone } from "lucide-react";
import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useLiveMedia } from "@/lib/live-call-media";
import { stateForBot } from "@/lib/mascot";
import { useShowThreads } from "@/lib/thread-preferences";
import { api, openBotRow, useStore, type Bot } from "@/state/store";
import { useChiefStepOpen } from "@/lib/default-bot";

import { BotAvatar } from "./Avatar";
import { botTooltip } from "./BotModelBadge";
import { liveBadgeFor } from "./LiveCallPill";
import { pinnedCircleDragClass, pinnedCircleDragHandlers, usePinnedCircleDrag, type PinnedCircleDragProps } from "./PinnedCircleThreads";
import { RenameTitle } from "./RenameTitle";
import { openBotContextMenu, useVisibleMessages, type BotRowProps } from "./Sidebar";
import { sidebarBotStatus } from "./SidebarBotActivity";
import { SimpleSectionLabel } from "./SidebarSimpleNav";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";
import { useBotUnread } from "./unread-notice";

export const TILE_COLUMNS = "repeat(auto-fill, minmax(max(60px, calc((100% - 6px) / 4)), 1fr))";
const RING = "ring-2 ring-[var(--tile)]";

type TileProps = BotRowProps & PinnedCircleDragProps & { primary?: boolean; kind?: "bot" };

export const SidebarBotTile = memo(function SidebarBotTile({ primary = false, kind, drag, dragging, drop, prevId, nextId, ...row }: TileProps) {
  const { bot, selected, deleting, mascotMotion, pendingQueued, instances, liveCall, dispatch, onMenu, renameRequest } = row;
  const showThreads = useShowThreads();
  const liveMedia = useLiveMedia();
  const remoteClient = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const [renaming, setRenaming] = useState(false);
  const visible = useVisibleMessages(bot);
  const { waiting, working, failed, teammateWait, queued } = sidebarBotStatus(bot, pendingQueued, visible);
  const { unread, noticing } = useBotUnread(bot);
  const onLiveCall = liveBadgeFor(bot.id, liveMedia, liveCall);
  const tooltip = botTooltip(bot, instances);
  const status = waiting ? t("sidebar.preview.waiting") : working ? t("chat.activity.working") : failed ? t("sidebar.preview.failed") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : queued ? t("task.queued") : "";
  const label = [bot.name, bot.chiefOfStaff ? t("sidebar.bot.chiefOfStaff") : "", onLiveCall ? t("call.live.badge") : "", status, unread ? t("task.unread") : ""].filter(Boolean).join(" · ");
  const reorder = pinnedCircleDragHandlers(bot.id, { drag, dragging, prevId, nextId });
  const open = () => openBotRow(dispatch, bot, showThreads, selected);
  const rename = (name: string) => {
    if (!remoteClient) return dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
    void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
      .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
      .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu({ botId: bot.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    } else {
      reorder.onKeyDown?.(event);
    }
  };
  const dot = (testId: string, tone: string) => <span data-testid={testId} aria-hidden="true" className={cn("absolute -right-0.5 -top-0.5 size-3 rounded-full", tone, RING)} />;
  return (
    <div
      role={renaming ? undefined : "button"}
      tabIndex={renaming ? undefined : 0}
      data-sidebar-bot-row={bot.id}
      data-sidebar-tile={kind ?? (primary ? "primary" : "pinned")}
      draggable={Boolean(drag) && !renaming} data-look="sidebar-bot"
      aria-label={renaming ? undefined : label}
      aria-current={selected && !renaming ? "page" : undefined}
      aria-busy={deleting || undefined}
      aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      title={tooltip}
      {...reorder}
      onClick={(event: MouseEvent) => { if (!renaming && !(event.target instanceof HTMLInputElement)) open(); }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => openBotContextMenu(onMenu, bot.id, event)}
      className={cn(
        "group/tile flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg bg-[var(--tile)] px-0.5 pb-1.5 pt-2 transition-colors duration-150 motion-reduce:transition-none", SIMPLE_ROW_FOCUS,
        selected ? "[--tile:var(--color-raised)]" : "[--tile:var(--color-panel)] hover:[--tile:color-mix(in_srgb,var(--color-raised)_50%,var(--color-panel))]",
        pinnedCircleDragClass({ drag, dragging, drop }),
      )}
    >
      <span className="relative flex transition-transform duration-[120ms] group-hover/tile:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none">
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={48}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          animated={working || noticing || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {primary && bot.chiefOfStaff && (
          <span data-testid="chief-badge" className={cn("absolute -bottom-px -right-px flex size-4 items-center justify-center rounded-full bg-[#E8993A] text-white", RING)}>
            <Crown size={10} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
          </span>
        )}
        {onLiveCall ? (
          <span data-testid="live-call-badge" className={cn("absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-success", RING)}>
            <Phone size={9} strokeWidth={2.5} aria-hidden="true" />
          </span>
        ) : waiting ? (
          <span data-testid="waiting-dot" aria-hidden="true" className={cn("absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-warning text-[11px] font-black leading-none text-panel", RING)}>!</span>
        ) : working ? dot("working-dot", "bg-success")
          : failed ? dot("failed-dot", "bg-danger")
          : teammateWait ? dot("teammate-wait-dot", "bg-accent")
          : queued ? dot("queued-dot", "bg-ink-tertiary")
          : unread ? dot("unread-dot", "bg-accent")
          : null}
        {deleting && (
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-panel/60 text-ink-secondary">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="flex w-full min-w-0 justify-center">
        <RenameTitle
          value={bot.name}
          editRequest={renameRequest}
          title={tooltip}
          onCommit={rename}
          onEditingChange={setRenaming}
          className="min-w-0 truncate text-center text-[12px] font-medium leading-4 text-ink"
          inputClassName="w-full rounded bg-inset px-1 text-center text-[12px] font-medium leading-4"
        />
      </span>
    </div>
  );
});

/** The sidebar while the first run's Chief step is open over an app with no bots of the person's own yet. */
export function SidebarNoBots() {
  const { state } = useStore();
  const chiefStep = useChiefStepOpen();
  if (!chiefStep || state.bots.some((bot) => !bot.hidden && !bot.defaultBot)) return null;
  return <p data-sidebar-empty="" className="px-5 pt-4 text-[13px] leading-[18px] text-ink-tertiary">{t("onboarding.shell.noBots")}</p>;
}

export function SidebarTileGrid({ primary, pinned, others = [], row, onAdd }: { primary: Bot | null; pinned: Bot[]; others?: Bot[]; row: (bot: Bot) => BotRowProps; onAdd?: () => void }) {
  const order = usePinnedCircleDrag(pinned);
  if (!primary && order.ranked.length === 0 && others.length === 0) return null;
  return (
    <section data-sidebar-tiles="" aria-label={t("sidebar.section.bots")} className="px-3 pb-2 pt-1">
      <SimpleSectionLabel name={t("sidebar.section.bots")} addLabel={onAdd ? t("sidebar.newBotSimple") : undefined} onAdd={onAdd} />
      <div className="grid max-h-[40vh] gap-0.5 overflow-y-auto py-0.5" style={{ gridTemplateColumns: TILE_COLUMNS }} {...order.frameProps}>
        {primary && <SidebarBotTile {...row(primary)} primary />}
        {order.ranked.map((bot) => <SidebarBotTile key={bot.id} {...row(bot)} {...order.dragProps(bot)} />)}
        {others.map((bot) => <SidebarBotTile key={bot.id} {...row(bot)} kind="bot" />)}
        <span role="status" className="sr-only">{order.moved}</span>
      </div>
    </section>
  );
}

export function SidebarSectionTiles({ bots, row }: { bots: Bot[]; row: (bot: Bot) => BotRowProps }) {
  if (bots.length === 0) return null;
  return (
    <div data-sidebar-section-tiles="" className="grid gap-0.5 py-0.5" style={{ gridTemplateColumns: TILE_COLUMNS }}>
      {bots.map((bot) => <SidebarBotTile key={bot.id} {...row(bot)} kind="bot" />)}
    </div>
  );
}
