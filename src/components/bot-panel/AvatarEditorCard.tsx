import { useEffect, useRef, type KeyboardEvent } from "react";

import { t } from "@/lib/i18n";
import type { MascotState } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { AvatarEditor } from "../avatar/AvatarEditor";
import { useAvatarImage, type AvatarPatch } from "../avatar-editing";

export type { AvatarEditorTab } from "../avatar/AvatarEditor";

export function AvatarEditorCard({ bot, activeState, onPatch, onClose }: {
  bot: Bot;
  activeState: MascotState;
  onPatch: (patch: AvatarPatch) => void;
  onClose: () => void;
}) {
  const image = useAvatarImage(bot, onPatch);
  const cardRef = useRef<HTMLDivElement>(null);
  // The card is a dialog: focus moves into it, onto the tab it opened on, so Escape and Tab work from the start.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t("botPanel.avatar.edit")}
      data-panel-avatar-editor data-look="popover"
      onKeyDown={onKeyDown}
      className="popover-surface absolute inset-x-[-5px] top-[80px] z-30 overflow-hidden rounded-2xl border border-ink/[0.08] bg-menu p-3 text-left shadow-2xl shadow-black/50"
    >
      <AvatarEditor bot={bot} activeState={activeState} image={image} variant="popover" onPatch={onPatch} />
    </div>
  );
}
