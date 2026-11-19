import type { RefObject } from "react";
import { ChevronRight, Crown, Folder, Gauge, MessageSquare, MessagesSquare, Settings, Timer, UserPlus, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { effectiveDefaultResponder } from "@/lib/group-routing";
import { t } from "@/lib/i18n";
import { responderShortLabel } from "@/lib/room-responder";
import { useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { ConversationTurnLimit } from "../ConversationTurnLimit";
import { groupUsageSummary } from "../GroupUsageChip";
import { roomWorkingFolder } from "../RoomWorkingFolder";
import { Card, NavRow, rowCls, RowIcon, RowText } from "../bot-panel/rows";
import { InstructionsRow } from "./InstructionsRow";

export type AdvancedRoomPage = "responder" | "folder";

function Hero({ group, members }: { group: Group; members: Bot[] }) {
  const [first, second] = members;
  return (
    <div className="flex items-center gap-3.5 px-1">
      <div data-room-panel-faces className="relative size-14 shrink-0">
        {first && <span className="absolute start-0 top-0 flex rounded-full"><BotAvatar bot={first} state="happy" size={36} animated={false} /></span>}
        {second && <span className="absolute bottom-0 end-0 flex rounded-full ring-2 ring-panel"><BotAvatar bot={second} state="happy" size={36} animated={false} /></span>}
      </div>
      <div className="min-w-0">
        <h2 id="room-panel-title" className="truncate text-[17px] font-semibold leading-[22px] text-ink">{group.name}</h2>
        <p className="text-[13px] text-ink-secondary">{t(members.length === 1 ? "room.panel.botsAndYouOne" : "room.panel.botsAndYouMany", { count: members.length })}</p>
      </div>
    </div>
  );
}

type Quick = "message" | "addBot" | "settings";
const QUICK: Record<Quick, { Icon: LucideIcon; label: Parameters<typeof t>[0] }> = {
  message: { Icon: MessageSquare, label: "botPanel.quick.message" },
  addBot: { Icon: UserPlus, label: "room.panel.addBot" },
  settings: { Icon: Settings, label: "botPanel.quick.settings" },
};

function QuickActions({ onAction }: { onAction: (action: Quick) => void }) {
  return (
    <div data-panel-quick className="mt-4 grid w-full grid-cols-3 gap-1.5">
      {(Object.keys(QUICK) as Quick[]).map((action) => {
        const { Icon, label } = QUICK[action];
        return (
          <button
            key={action}
            type="button"
            data-panel-quick-action={action}
            onClick={() => onAction(action)}
            className="flex h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl bg-ink/[0.04] px-1 text-[12px] leading-4 text-ink-secondary transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon size={16} aria-hidden="true" className="shrink-0 text-ink" />
            <span className="max-w-full truncate">{t(label)}</span>
          </button>
        );
      })}
    </div>
  );
}

function leadOf(group: Group, members: Bot[]): string | undefined {
  const responder = effectiveDefaultResponder(group, members);
  if (responder.kind === "member") return responder.botId;
  return responder.kind === "auto" ? responder.fallbackBotId : undefined;
}

function MemberRow({ group, member, lead }: { group: Group; member: Bot; lead: boolean }) {
  const { dispatch } = useStore();
  const working = group.busyBotId === member.id;
  const held = Boolean(group.holds?.[member.id]);
  const chief = t("chat.chiefOfStaff");
  const role = member.title.trim() || (member.chiefOfStaff ? chief : "");
  return (
    <button
      type="button"
      data-panel-member={member.id}
      title={held ? t("room.holds.avatarHeld", { name: member.name }) : working ? `${member.name} — ${t("room.member.working")}` : undefined}
      aria-label={t("chat.openProfileAria", { name: member.name })}
      onClick={() => dispatch({ type: "toggleSettings", open: true, botId: member.id })}
      className={cn(rowCls, "h-11 min-h-0 w-full py-0 text-left hover:bg-ink/[0.03]")}
    >
      <span className="relative flex shrink-0">
        <BotAvatar bot={member} state="happy" size={24} animated={false} />
        {(working || held) && (
          <span
            data-member-status={working ? "working" : "held"}
            aria-hidden="true"
            className={cn("absolute -bottom-0.5 -end-0.5 size-2.5 rounded-full ring-2 ring-panel", working ? "bg-success" : "bg-warning")}
          />
        )}
      </span>
      <span dir="auto" className="min-w-0 truncate text-[14px] text-ink">{member.name}</span>
      {lead && <span title={t("room.panel.lead")} className="flex shrink-0 text-warning"><Crown size={13} aria-hidden="true" /><span className="sr-only">{t("room.panel.lead")}</span></span>}
      <span className="min-w-0 flex-1" />
      {role && <span dir="auto" className="min-w-0 max-w-[170px] truncate text-[13px] text-ink-tertiary">{role}</span>}
      <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />
    </button>
  );
}

/** The room panel's first view in Advanced mode: who is in the room, then everything the header used to carry. */
export function AdvancedRoomMain({ group, members, settingsRef, onMessage, onAddBot, onSettings, onOpenPage }: {
  group: Group;
  members: Bot[];
  settingsRef: RefObject<HTMLDivElement | null>;
  onMessage: () => void;
  onAddBot: () => void;
  onSettings: () => void;
  onOpenPage: (page: AdvancedRoomPage) => void;
}) {
  const lead = leadOf(group, members);
  const folder = roomWorkingFolder(group);
  const usage = groupUsageSummary(group.usage);
  const quick = (action: Quick) => (action === "message" ? onMessage : action === "addBot" ? onAddBot : onSettings)();
  return (
    <>
      <div className="mt-3.5"><Hero group={group} members={members} /></div>
      <QuickActions onAction={quick} />
      <Card label={t("room.panel.members")} anchor="members">
        {members.map((member) => <MemberRow key={member.id} group={group} member={member} lead={member.id === lead} />)}
      </Card>
      <div ref={settingsRef} data-panel-settings className="scroll-mt-2">
        <Card label={t("botPanel.quick.settings")} anchor="settings">
          <NavRow
            data-panel-page="responder"
            icon={MessagesSquare}
            title={t("room.panel.whoResponds")}
            value={responderShortLabel(group, members)}
            onClick={() => onOpenPage("responder")}
          />
          <div data-panel-row="turn-limit" className={rowCls}>
            <RowIcon icon={Timer} />
            <RowText title={t("room.panel.turnLimit")} />
            <ConversationTurnLimit group={group} />
          </div>
          <NavRow
            data-panel-page="folder"
            icon={Folder}
            title={t("room.folder.title")}
            value={folder?.name ?? t("room.panel.folder.own")}
            tooltip={folder?.path}
            onClick={() => onOpenPage("folder")}
          />
          <InstructionsRow group={group} />
          {usage && (
            <div data-panel-row="usage" className={rowCls}>
              <RowIcon icon={Gauge} />
              <RowText title={t("chat.usage.menu")} />
              <span title={usage.title} tabIndex={0} data-testid="group-usage-chip" className="text-[13px] tabular-nums text-ink-secondary">{usage.short}</span>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
