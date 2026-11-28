import { useMemo, useState, type DragEvent, type ReactNode } from "react";

import type { BoardCard } from "../../../shared/board";
import type { Todo } from "../../../shared/todo";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { ByBotCard, TODO_DRAG_TYPE } from "./ByBotCard";
import { canDragTodo, inLineOrder, isOpenTodo, isTodoCard, todoGroupOf } from "./board-model";
import { moveTodoCard } from "./todo-actions";
import { todoLine } from "./todo-line";

type Hover = { target: string; before?: string | null } | null;
const OPEN = "open";

const LANE_LABEL = "text-[12px] font-medium text-ink-tertiary";
const startsLabel = (bot: Bot) => (bot.startsTodos === "manual" ? t("board.byBot.startsManual") : t("board.byBot.startsAuto"));

function startOfToday(): number {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function ByBotView({ cards, allCards, bots, filter, picker, todos, openId, narrow, form, onOpen }: {
  cards: readonly BoardCard[];
  allCards: readonly BoardCard[];
  bots: readonly Bot[];
  filter: string | null;
  picker: string | null;
  todos: ReadonlyMap<string, Todo>;
  openId: string | null;
  narrow: boolean;
  form: ReactNode;
  onOpen: (card: BoardCard) => void;
}) {
  const { dispatch } = useStore();
  const [dragId, setDragId] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const ctx = { bots, picker, todos };
  const pickerBot = picker ? bots.find((bot) => bot.id === picker) : undefined;

  const openCards = useMemo(() => cards.filter(isOpenTodo), [cards]);
  const rows = filter ? bots.filter((bot) => bot.id === filter) : bots;
  const doneToday = useMemo(() => cards.filter((card) => card.column === "done" && card.updatedAt >= startOfToday()), [cards]);
  const dragged = dragId ? allCards.find((card) => card.id === dragId) : undefined;

  const lanes = (bot: Bot) => {
    const own = cards.filter((card) => card.botId === bot.id);
    const todoCards = own.filter((card) => card.column === "todo");
    return {
      now: own.filter((card) => card.column === "working" || card.column === "needs-you"),
      next: inLineOrder(todoCards.filter((card) => todoGroupOf(card) !== "scheduled"), bots),
      later: todoCards.filter((card) => todoGroupOf(card) === "scheduled"),
    };
  };

  const end = () => { setDragId(null); setHover(null); };
  const carries = (event: DragEvent<HTMLElement>) => Boolean(dragged) && event.dataTransfer.types.includes(TODO_DRAG_TYPE);
  const start = (card: BoardCard) => (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData(TODO_DRAG_TYPE, card.id);
    event.dataTransfer.effectAllowed = "move";
    setDragId(card.id);
  };
  const drop = (target: string | null, before?: string | null) => {
    const card = dragged;
    end();
    if (!card || !canDragTodo(card)) return;
    if (before !== undefined && before === card.todoId) return;
    if (target === null && !card.botId) return;
    void moveTodoCard(card, { botId: target, ...(before !== undefined ? { beforeId: before } : {}) }, allCards, bots);
  };
  const over = (target: string, before?: string | null) => (event: DragEvent<HTMLElement>) => {
    if (!carries(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (hover?.target !== target || hover.before !== before) setHover({ target, before });
  };
  const dropOn = (target: string | null, before?: string | null) => (event: DragEvent<HTMLElement>) => {
    if (!carries(event)) return;
    event.preventDefault();
    event.stopPropagation();
    drop(target, before);
  };
  const beforeAt = (card: BoardCard, line: readonly BoardCard[]) => (event: DragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const upper = event.clientY < box.top + box.height / 2;
    const at = line.findIndex((one) => one.id === card.id);
    return upper ? card.todoId ?? null : line[at + 1]?.todoId ?? null;
  };

  const stepFor = (card: BoardCard, line: readonly BoardCard[]) => (direction: -1 | 1) => {
    const at = line.findIndex((one) => one.id === card.id);
    if (at < 0 || !card.botId) return;
    const target = at + direction;
    if (target < 0 || target >= line.length) return;
    const beforeId = direction === -1 ? line[target]?.todoId ?? null : line[target + 1]?.todoId ?? null;
    void moveTodoCard(card, { botId: card.botId, beforeId }, allCards, bots).then(() => {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-board-card="${CSS.escape(card.id)}"]`)?.focus());
    });
  };

  const openPanelOf = (bot: Bot) => { dispatch({ type: "showChat" }); dispatch({ type: "toggleSettings", open: true, botId: bot.id }); };

  const card = (one: BoardCard, owner: Bot | undefined, extra: Partial<Parameters<typeof ByBotCard>[0]> = {}) => (
    <ByBotCard key={one.id} card={one} bots={bots} owner={owner} line={isTodoCard(one) ? todoLine(one, ctx) : null} selected={openId === one.id} dragging={dragId === one.id}
      onOpen={() => onOpen(one)} onDragStart={start(one)} onDragEnd={end} onMove={(botId) => void moveTodoCard(one, { botId }, allCards, bots)} {...extra} />
  );

  const openBand = openCards.length > 0 || dragId !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-2 sm:px-6">
      {form}
      {openBand && (
        <section aria-label={t("board.byBot.openLabel")} data-board-open-band="" onDragOver={over(OPEN)} onDrop={dropOn(null)}
          className={cn("rounded-xl bg-inset p-3", hover?.target === OPEN && "outline outline-2 -outline-offset-2 outline-accent/70")}>
          <h2 className="flex flex-wrap items-center gap-x-2 text-[13px] font-semibold text-ink">
            {t("board.group.open")}
            <span className="text-[12px] font-normal text-ink-tertiary">{pickerBot ? t("board.byBot.openPicker", { bot: pickerBot.name }) : t("board.byBot.openNobody")}</span>
          </h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {openCards.map((one) => card(one, undefined))}
          </div>
        </section>
      )}
      <div role="table" aria-label={t("board.byBot.table")} className="min-w-0">
        {!narrow && (
          <div role="row" className={cn("grid grid-cols-[minmax(150px,200px)_repeat(3,minmax(0,1fr))] gap-3 px-2 pb-1", LANE_LABEL)}>
            <span role="columnheader">{t("board.byBot.bot")}</span>
            <span role="columnheader">{t("board.byBot.now")}</span>
            <span role="columnheader">{t("board.group.next")}</span>
            <span role="columnheader">{t("board.byBot.later")}</span>
          </div>
        )}
        {rows.map((bot) => {
          const lane = lanes(bot);
          const hot = hover?.target === bot.id;
          const picking = picker === bot.id && openCards.length > 0;
          const cell = (label: string, children: ReactNode, key: string) => (
            <div role="cell" data-board-lane={key} className="flex min-w-0 flex-col gap-2">
              {narrow && <span className={LANE_LABEL}>{label}</span>}
              {children}
            </div>
          );
          return (
            <div key={bot.id} role="row" data-board-bot-row={bot.id} onDragOver={over(bot.id)} onDrop={dropOn(bot.id)}
              className={cn("grid gap-3 rounded-xl border-t border-hairline/50 px-2 py-3", narrow ? "grid-cols-1" : "grid-cols-[minmax(150px,200px)_repeat(3,minmax(0,1fr))]", hot && "bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70")}>
              <div role="cell" className="flex min-w-0 items-start gap-2.5">
                <BotAvatar bot={bot} size={32} label="" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-ink">{bot.name}</span>
                  {bot.title && <span className="truncate text-[12px] text-ink-tertiary">{bot.title}</span>}
                  <button type="button" data-board-starts={bot.startsTodos === "manual" ? "manual" : "auto"} title={t("board.byBot.changeInPanel", { bot: bot.name })}
                    aria-label={`${startsLabel(bot)}. ${t("board.byBot.changeInPanel", { bot: bot.name })}`} onClick={() => openPanelOf(bot)}
                    className="mt-0.5 w-fit max-w-full truncate rounded-md text-start text-[12px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                    {startsLabel(bot)}
                  </button>
                </div>
              </div>
              {cell(t("board.byBot.now"), <>
                {picking && <p className="text-[12px] text-ink-tertiary">{t(openCards.length === 1 ? "board.byBot.picking.one" : "board.byBot.picking.other", { count: openCards.length })}</p>}
                {lane.now.map((one) => card(one, bot))}
                {lane.now.length === 0 && !picking && <span className="text-[12px] text-ink-tertiary">{t("board.byBot.free")}</span>}
              </>, "now")}
              {cell(t("board.group.next"), lane.next.map((one, index) => card(one, bot, {
                number: index + 1,
                drop: hover?.target === bot.id && hover.before === one.todoId ? "before" : hover?.target === bot.id && hover.before === null && index === lane.next.length - 1 ? "after" : null,
                onDragOver: (event) => over(bot.id, beforeAt(one, lane.next)(event))(event),
                onDrop: (event) => dropOn(bot.id, beforeAt(one, lane.next)(event))(event),
                onStep: stepFor(one, lane.next), canStepUp: index > 0, canStepDown: index < lane.next.length - 1,
              })), "next")}
              {cell(t("board.byBot.later"), lane.later.map((one) => card(one, bot)), "later")}
            </div>
          );
        })}
      </div>
      {doneToday.length > 0 && (
        <details data-board-done-today="" onToggle={(event) => setDoneOpen(event.currentTarget.open)} className="group rounded-xl">
          <summary className="flex h-8 w-fit cursor-pointer items-center rounded-full bg-control px-3 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
            {doneOpen ? t("board.byBot.doneToday") : t("board.byBot.doneTodayCount", { count: doneToday.length })}
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {doneToday.map((one) => card(one, bots.find((bot) => bot.id === one.botId)))}
          </div>
        </details>
      )}
    </div>
  );
}
