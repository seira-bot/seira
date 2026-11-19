import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronRight, FileText } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Group } from "@/state/store";
import { useBulletinEditor } from "../RoomBulletin";
import { buttonCls, ColRow, rowCls, RowText } from "../bot-panel/rows";

export function InstructionsRow({ group }: { group: Group }) {
  const bulletin = useBulletinEditor(group);
  const editRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (bulletin.open || !refocus.current) return;
    refocus.current = false;
    editRef.current?.focus();
  }, [bulletin.open]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) refocus.current = true;
    bulletin.onKeyDown(event);
  };

  if (bulletin.open) {
    return (
      <ColRow data-panel-row="instructions">
        <RowText title={t("room.panel.instructions")} />
        <textarea
          autoFocus
          dir="auto"
          aria-label={t("room.panel.instructions")}
          value={bulletin.draft}
          onChange={(event) => bulletin.setDraft(event.target.value)}
          onBlur={bulletin.save}
          onKeyDown={onKeyDown}
          placeholder={t("room.bulletin.placeholder")}
          rows={6}
          className="w-full resize-y rounded-lg border border-hairline bg-inset px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border"
        />
        <div className="flex justify-end">
          <button
            type="button"
            data-panel-done="instructions"
            // Keeps the field focused, so its blur does not save before Done does.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              refocus.current = true;
              bulletin.save();
            }}
            className={buttonCls}
          >
            {t("botSettings.simple.done")}
          </button>
        </div>
      </ColRow>
    );
  }
  const firstLine = group.bulletin.split("\n")[0]?.trim();
  return (
    <button
      ref={editRef}
      type="button"
      data-panel-edit="instructions"
      aria-label={`${t("botSettings.simple.edit")}: ${t("room.panel.instructions")}`}
      onClick={bulletin.start}
      className={cn(rowCls, "w-full text-left hover:bg-ink/[0.03]")}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] text-ink-secondary max-md:size-8 max-md:rounded-full" aria-hidden="true">
        <FileText size={15} />
      </span>
      <RowText
        title={t("room.panel.instructions")}
        hint={<span dir="auto" className="line-clamp-1">{firstLine || t("room.panel.instructionsHint")}</span>}
      />
      <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
    </button>
  );
}
