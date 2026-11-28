import { Check, UserRound } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { showToast } from "@/lib/power";
import { ui } from "@/lib/ui-anchor";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { setTodoPicker } from "@/state/todos";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { BOARD_MENU_ROW, BoardMenu } from "./BoardMenu";

/** The pill that says who gives open todos to a bot, and the menu that changes it. */
export function PickerMenu({ bots, picker }: { bots: readonly Bot[]; picker: string | null }) {
  const allowed = useOwnerOrAdmin();
  const current = picker ? bots.find((bot) => bot.id === picker) : undefined;
  const choose = (botId: string | null, close: () => void) => {
    close();
    if (botId === picker) return;
    setTodoPicker(botId).catch(() => showToast(t("board.picker.failed")));
  };

  return (
    <BoardMenu ui={ui("board.picker")} label={t("board.picker.label")} disabled={allowed === false} disabledReason={t("board.picker.adminOnly")}
      summary={<>
        {current ? <BotAvatar bot={current} size={18} label="" /> : <UserRound size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-tertiary" />}
        <span className="min-w-0 truncate">{current ? t("board.picker.picks", { bot: current.name }) : t("board.picker.youPick")}</span>
      </>}>
      {(close) => (
        <>
          <div className="px-2 pb-1 pt-1.5">
            <p className="text-[13px] font-medium text-ink">{t("board.picker.label")}</p>
            <p className="mt-0.5 text-[12px] leading-4 text-ink-tertiary">{t("board.picker.line")}</p>
          </div>
          {bots.map((bot) => (
            <button key={bot.id} type="button" role="menuitemradio" aria-checked={bot.id === picker} tabIndex={-1} onClick={() => choose(bot.id, close)} className={cn(BOARD_MENU_ROW, "py-1.5")}>
              <BotAvatar bot={bot} size={22} label="" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{bot.name}</span>
                <span className="truncate text-[12px] text-ink-tertiary">{[bot.title, bot.chiefOfStaff ? t("board.picker.byDefault") : ""].filter(Boolean).join(" · ")}</span>
              </span>
              {bot.id === picker && <Check size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
            </button>
          ))}
          <div role="separator" className="mx-2 my-1 h-[0.5px] bg-ink/10" />
          <button type="button" role="menuitemradio" aria-checked={picker === null} tabIndex={-1} onClick={() => choose(null, close)} className={cn(BOARD_MENU_ROW, "py-1.5")}>
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-ink-secondary"><UserRound size={13} strokeWidth={1.75} aria-hidden="true" /></span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{t("board.picker.nobody")}</span>
              <span className="text-[12px] leading-4 text-ink-tertiary">{t("board.picker.nobodyLine")}</span>
            </span>
            {picker === null && <Check size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
          </button>
        </>
      )}
    </BoardMenu>
  );
}
