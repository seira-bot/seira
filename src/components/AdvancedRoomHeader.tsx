import { ChevronDown, Square } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { normalizeState } from "@/lib/mascot";
import { closeRoomPanel, openRoomPanel, useRoomPanel } from "@/lib/room-panel";
import { useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { RoomPicture } from "./RoomPicture";
import { useCaptionChrome } from "./DesktopCapabilities";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "./elevated";
import { RoomHeaderCallButton } from "./GroupCallView";
import { PinnedMessagesMenu, pinnedPreview } from "./PinnedMessagesMenu";
import { RoomMoreMenu } from "./RoomMoreMenu";
import { GroupTaskPicker } from "./TaskPicker";
import { ThreadPresenceFaces } from "./TeamPresence";

const FACES = 3;

/** Advanced mode's room header, laid out like the bot chat's: the conversation chip, the room pill that opens the
 * room panel, then Stop while a turn runs and the call, pins and ⋯ controls. */
export function AdvancedRoomHeader({ group, members, working, folderOpen, onToggleFolder }: {
  group: Group;
  members: Bot[];
  working: boolean;
  folderOpen: boolean;
  onToggleFolder: () => void;
}) {
  const { dragProps, noDragStyle } = useCaptionChrome();
  const { dispatch } = useStore();
  const panelOpen = useRoomPanel() === group.id;
  const toggle = (opener: HTMLElement) => (panelOpen ? closeRoomPanel() : openRoomPanel(group.id, opener));
  return (
    <div {...dragProps} data-look="room-header" className="@container/roomhead px-5 py-2.5 pl-11 md:pl-5 max-md:pl-14 max-md:pr-3">
      <div
        data-roomhead-row
        className="flex items-center justify-between @max-[30rem]/roomhead:flex-wrap @max-[30rem]/roomhead:gap-y-1 @min-[30rem]/roomhead:grid @min-[30rem]/roomhead:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] @min-[30rem]/roomhead:gap-3"
      >
        <div data-roomhead-identity className="flex min-w-0 flex-col items-center @max-[30rem]/roomhead:basis-full @min-[30rem]/roomhead:col-start-2 @min-[30rem]/roomhead:justify-self-center" style={noDragStyle}>
          <button
            type="button"
            data-room-name
            data-chathead-pill
            onClick={(event) => toggle(event.currentTarget)}
            title={t("room.panel.open")}
            aria-label={t("room.panel.openAria", { name: group.name })}
            aria-haspopup="dialog"
            aria-expanded={panelOpen}
            className={cn("group flex min-w-0 max-w-full items-center gap-2 rounded-full py-[7.5px] pl-[7.5px] pr-[13.5px] text-ink", ELEVATED_FLOAT, ELEVATED_HOVER)}
          >
            <RoomPicture url={group.dm ? null : group.avatarUrl} size={28} fallback={<span aria-hidden="true" className="flex shrink-0 items-center -space-x-1.5">
              {members.slice(0, FACES).map((member) => (
                <span key={member.id} className="flex rounded-full ring-2 ring-composer">
                  <BotAvatar bot={member} state={normalizeState(member.mascotExpression) ?? "happy"} size={24} animated={false} />
                </span>
              ))}
            </span>} />
            <span dir="auto" className="min-w-0 truncate text-[14px] font-semibold leading-5">{group.name}</span>
            <span data-room-count className="shrink-0 text-[13px] leading-5 text-ink-tertiary max-md:hidden">
              {t(members.length === 1 ? "routines.botCountOne" : "routines.botCountMany", { count: members.length })}
            </span>
            <ChevronDown size={14} aria-hidden="true" className={cn("shrink-0 text-ink-tertiary transition-transform duration-[140ms] motion-reduce:transition-none", panelOpen && "rotate-180")} />
          </button>
          {group.description && <p className="max-w-full truncate text-[12px] leading-4 text-ink-secondary">{group.description}</p>}
        </div>
        <div data-roomhead-thread className="min-w-0 max-w-full @min-[30rem]/roomhead:justify-self-stretch @min-[30rem]/roomhead:col-start-1 @min-[30rem]/roomhead:row-start-1" style={noDragStyle}>
          <GroupTaskPicker group={group} chip />
        </div>
        <div
          data-roomhead-controls
          className="flex shrink-0 items-center gap-2 @max-[30rem]/roomhead:ml-auto @min-[30rem]/roomhead:col-start-3 @min-[30rem]/roomhead:justify-self-end"
          style={noDragStyle}
        >
          <ThreadPresenceFaces threadId={group.threadId} />
          {working && (
            <button
              type="button"
              data-room-stop
              aria-label={t("chat.stop")}
              onClick={() => dispatch({ type: "interruptGroup", groupId: group.id, threadId: group.threadId })}
              title={t("chat.stopTurn")}
              className="flex h-7 items-center gap-1.5 rounded-full bg-ink/[0.06] px-2.5 text-[12px] font-medium text-ink hover:bg-ink/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Square size={10} aria-hidden="true" className="fill-current" />
              <span className="@max-4xl/roomhead:hidden">{t("chat.stop")}</span>
            </button>
          )}
          <RoomHeaderCallButton group={group} members={members} />
          <PinnedMessagesMenu
            pins={pinnedPreview(group.messages, group.pinnedMessageId, t("room.aBot"), false)}
            triggerClassName={cn(ELEVATED_FLOAT, ELEVATED_HOVER)}
            onJump={(messageId) => dispatch({ type: "focusMessage", threadId: group.threadId, messageId })}
            onUnpin={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
          />
          <RoomMoreMenu group={group} folder={{ open: folderOpen, onToggle: onToggleFolder }} />
        </div>
      </div>
    </div>
  );
}
