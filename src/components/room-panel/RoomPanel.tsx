import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Folder, MessagesSquare, Users, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closeRoomPanel } from "@/lib/room-panel";
import { responderShortLabel } from "@/lib/room-responder";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { useCaptionChrome } from "../DesktopCapabilities";
import { ManageMembersPanel } from "../ManageMembersPanel";
import { RoomMoreMenu } from "../RoomMoreMenu";
import { RoomWorkingFolder, roomWorkingFolder } from "../RoomWorkingFolder";
import { Card, NavRow, PageHeader, roundButtonCls } from "../bot-panel/rows";
import { sidePanelCls } from "../bot-panel/side-panel";
import { AdvancedRoomMain } from "./AdvancedRoomMain";
import { InstructionsRow } from "./InstructionsRow";
import { ResponderPage } from "./ResponderPage";

type RoomPage = "responder" | "folder";

const PAGES: Record<RoomPage, { title: LocaleKey; intro: LocaleKey }> = {
  responder: { title: "room.panel.whoResponds", intro: "room.panel.responder.intro" },
  folder: { title: "room.folder.title", intro: "room.folder.detail" },
};

function RoomHero({ group, members }: { group: Group; members: Bot[] }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div data-room-panel-faces className="mt-0.5 flex">
        {members.slice(0, 3).map((member, index) => (
          <span key={member.id} className={cn("rounded-full ring-[3px] ring-app", index > 0 && "-ms-4")}>
            <BotAvatar bot={member} state="happy" size={56} animated={false} />
          </span>
        ))}
      </div>
      <h2 id="room-panel-title" className="mt-2.5 max-w-full truncate px-1.5 text-[18px] font-semibold text-ink">{group.name}</h2>
      {group.description && <p className="mt-px line-clamp-2 max-w-full text-[13px] text-ink-secondary">{group.description}</p>}
    </div>
  );
}

export function RoomPanel({ group, overlay = false, advanced = false }: { group: Group; overlay?: boolean; advanced?: boolean }) {
  const { state } = useStore();
  const { dragProps } = useCaptionChrome();
  const [page, setPage] = useState<RoomPage | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const membersRowRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const leftPage = useRef<RoomPage | null>(null);
  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)),
    [group.memberIds, state.bots],
  );
  const folder = roomWorkingFolder(group);
  const closeMembers = useCallback(() => setMembersOpen(false), []);

  const openPage = (next: RoomPage) => {
    setPage(next);
    bodyRef.current?.scrollTo({ top: 0 });
  };
  const back = () => {
    leftPage.current = page;
    setPage(null);
  };
  const focusComposer = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());
  const showSettings = () => {
    settingsRef.current?.scrollIntoView({ block: "start" });
    settingsRef.current?.querySelector<HTMLElement>("button, select, input")?.focus();
  };

  // The row or Back button that was pressed is gone with the view it sat in: focus moves to its counterpart, so the
  // next Escape still lands in the panel.
  useEffect(() => {
    if (page !== null) {
      bodyRef.current?.querySelector<HTMLElement>("[data-panel-back]")?.focus();
    } else if (leftPage.current) {
      bodyRef.current?.querySelector<HTMLElement>(`[data-panel-page="${leftPage.current}"]`)?.focus();
      leftPage.current = null;
    }
  }, [page]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      event.preventDefault();
      closeRoomPanel({ refocus: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || page === null) return;
    event.preventDefault();
    event.stopPropagation();
    back();
  };

  return (
    <>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-labelledby="room-panel-title"
        tabIndex={-1}
        data-room-panel
        onKeyDown={onKeyDown}
        className={sidePanelCls(overlay, !advanced)}
      >
        <div {...dragProps} className="flex h-[52px] shrink-0 items-center justify-end gap-1.5 px-3">
          {!advanced && <RoomMoreMenu group={group} />}
          <button type="button" onClick={() => closeRoomPanel({ refocus: true })} aria-label={t("botSettings.simple.close")} className={roundButtonCls}>
            <X size={16} className="pointer-events-none" />
          </button>
        </div>

        <div ref={bodyRef} className={cn("@container relative min-h-0 flex-1 overflow-y-auto pb-7", advanced ? "px-4" : "px-5")}>
          {page === null && advanced ? (
            <AdvancedRoomMain
              group={group}
              members={members}
              settingsRef={settingsRef}
              onMessage={focusComposer}
              onAddBot={() => setMembersOpen(true)}
              onSettings={showSettings}
              onOpenPage={openPage}
            />
          ) : page === null ? (
            <>
              <RoomHero group={group} members={members} />
              <Card>
                <NavRow
                  data-panel-page="responder"
                  icon={MessagesSquare}
                  title={t("room.panel.whoResponds")}
                  value={responderShortLabel(group, members)}
                  onClick={() => openPage("responder")}
                />
                <NavRow
                  data-panel-page="folder"
                  icon={Folder}
                  title={t("room.folder.title")}
                  value={folder?.name ?? t("room.panel.folder.own")}
                  tooltip={folder?.path}
                  onClick={() => openPage("folder")}
                />
                <InstructionsRow group={group} />
                <NavRow
                  ref={membersRowRef}
                  data-panel-row="members"
                  icon={Users}
                  title={t("room.panel.members")}
                  value={String(members.length)}
                  onClick={() => setMembersOpen(true)}
                />
              </Card>
            </>
          ) : (
            <div data-panel-page-view={page}>
              <span id="room-panel-title" className="sr-only">{group.name}</span>
              <PageHeader back={group.name} title={t(PAGES[page].title)} intro={t(PAGES[page].intro)} onBack={back} />
              <div className="mt-4 flex flex-col gap-3">
                {page === "responder" ? <ResponderPage group={group} members={members} /> : <RoomWorkingFolder group={group} heading={false} />}
              </div>
            </div>
          )}
        </div>
      </aside>
      {membersOpen && createPortal(
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersRowRef} />,
        document.body,
      )}
    </>
  );
}
