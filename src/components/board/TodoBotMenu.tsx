import { ArrowDown, ArrowUp, Check, CircleDashed } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { BOARD_MENU_ROW, BoardMenu } from "./BoardMenu";

/** A menu that moves a todo: to a bot, back to Any bot, and a step up or down in the bot's Up next. */
export function TodoBotMenu({ label, summary, bots, current, allowAny, onChoose, onStep, canStepUp, canStepDown, caret, triggerClass, className, disabled }: {
  label: string;
  summary: ReactNode;
  bots: readonly Bot[];
  /** The bot the todo has now; null for Any bot; undefined marks none. */
  current: string | null;
  allowAny: boolean;
  onChoose: (botId: string | null) => void;
  onStep?: (direction: -1 | 1) => void;
  canStepUp?: boolean;
  canStepDown?: boolean;
  caret?: boolean;
  triggerClass?: string;
  className?: string;
  disabled?: boolean;
}) {
  const steps = onStep && (canStepUp || canStepDown);
  return (
    <BoardMenu label={label} summary={summary} caret={caret} triggerClass={triggerClass} className={className} disabled={disabled} menuClass="w-56">
      {(close) => (
        <>
          {allowAny && (
            <button type="button" role="menuitemradio" aria-checked={current === null} tabIndex={-1} onClick={() => { close(); onChoose(null); }} className={BOARD_MENU_ROW}>
              <CircleDashed size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
              <span className="min-w-0 flex-1 truncate">{t("todo.fields.anyBot")}</span>
              {current === null && <Check size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
            </button>
          )}
          {bots.map((bot) => (
            <button key={bot.id} type="button" role="menuitemradio" aria-checked={bot.id === current} tabIndex={-1} onClick={() => { close(); onChoose(bot.id); }} className={BOARD_MENU_ROW}>
              <BotAvatar bot={bot} size={18} label="" />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              {bot.id === current && <Check size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
            </button>
          ))}
          {steps && <div role="separator" className="mx-2 my-1 h-[0.5px] bg-ink/10" />}
          {steps && (
            <button type="button" role="menuitem" tabIndex={-1} disabled={!canStepUp} onClick={() => { close(); onStep(-1); }} className={cn(BOARD_MENU_ROW)}>
              <ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-secondary" />{t("board.todo.moveUp")}
            </button>
          )}
          {steps && (
            <button type="button" role="menuitem" tabIndex={-1} disabled={!canStepDown} onClick={() => { close(); onStep(1); }} className={cn(BOARD_MENU_ROW)}>
              <ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-secondary" />{t("board.todo.moveDown")}
            </button>
          )}
        </>
      )}
    </BoardMenu>
  );
}
