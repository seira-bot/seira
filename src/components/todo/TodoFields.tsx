import { useEffect, useRef } from "react";

import type { TodoDraft, TodoRepeat, TodoStart } from "../../../shared/todo";
import { TODO_NOTE_CHARS, TODO_TITLE_CHARS } from "../../../shared/todo";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { weekdayNames } from "@/lib/todo-labels";
import type { Bot } from "@/state/store";
import { Select } from "../Select";

export type TodoWhen =
  | { kind: "free" }
  | { kind: "tomorrow" }
  /** `at` is an <input type="datetime-local"> value. */
  | { kind: "at"; at: string }
  | { kind: "repeat"; time: string; weekdays: number[] };

export interface TodoFieldValues {
  title: string;
  note: string;
  /** null: any bot; the bot picker, or the person, chooses. */
  botId: string | null;
  when: TodoWhen;
}

const TOMORROW_HOUR = 9;
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const FIELD = "h-9 rounded-lg bg-inset px-3 text-[13px] text-ink shadow-[inset_0_0_0_0.5px_var(--color-edge)] placeholder:text-ink-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function emptyTodoFields(botId: string | null, title = "", note = ""): TodoFieldValues {
  return { title: title.slice(0, TODO_TITLE_CHARS), note: note.slice(0, TODO_NOTE_CHARS), botId, when: { kind: "free" } };
}

/** 9:00 tomorrow, local time. */
export function tomorrowMorning(now = new Date()): number {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(TOMORROW_HOUR, 0, 0, 0);
  return at.getTime();
}

/** The draft the form describes, or null while the title is empty or the time is not valid. */
export function draftFromFields(values: TodoFieldValues, now = new Date()): Pick<TodoDraft, "title" | "note" | "botId" | "start" | "repeat"> | null {
  const title = values.title.replace(/\s+/g, " ").trim().slice(0, TODO_TITLE_CHARS);
  if (!title) return null;
  const note = values.note.trim().slice(0, TODO_NOTE_CHARS);
  let start: TodoStart = { kind: "free" };
  let repeat: TodoRepeat | undefined;
  if (values.when.kind === "tomorrow") start = { kind: "at", at: tomorrowMorning(now) };
  if (values.when.kind === "at") {
    const at = new Date(values.when.at).getTime();
    if (!Number.isFinite(at) || at <= now.getTime()) return null;
    start = { kind: "at", at };
  }
  if (values.when.kind === "repeat") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.when.time)) return null;
    repeat = { time: values.when.time, weekdays: [...values.when.weekdays].sort((a, b) => a - b) };
  }
  return { title, ...(note ? { note } : {}), ...(values.botId ? { botId: values.botId } : {}), start, ...(repeat ? { repeat } : {}) };
}

/** The start rule a "free", "tomorrow" or "at" choice describes; null for a time that has passed or is not valid. */
export function startFromWhen(when: TodoWhen, now = new Date()): TodoStart | null {
  if (when.kind === "tomorrow") return { kind: "at", at: tomorrowMorning(now) };
  if (when.kind === "at") {
    const at = new Date(when.at).getTime();
    return Number.isFinite(at) && at > now.getTime() ? { kind: "at", at } : null;
  }
  return when.kind === "free" ? { kind: "free" } : null;
}

function localInputValue(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function whenFor(kind: TodoWhen["kind"], current: TodoWhen): TodoWhen {
  if (kind === current.kind) return current;
  if (kind === "at") return { kind, at: localInputValue(tomorrowMorning()) };
  if (kind === "repeat") return { kind, time: "09:00", weekdays: [] };
  return { kind };
}

/** Title, bot, start rule and note of a new todo. The Board's inline form and the chat's todo dialog both use it. */
export function TodoFields({ values, onChange, bots, picker, autoFocus = false, onSubmit }: {
  values: TodoFieldValues;
  onChange: (values: TodoFieldValues) => void;
  bots: readonly Bot[];
  /** The bot that picks a bot for open todos; null when the person picks. */
  picker: string | null;
  autoFocus?: boolean;
  /** Enter in the title field. */
  onSubmit?: () => void;
}) {
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) title.current?.focus(); }, [autoFocus]);
  const set = (patch: Partial<TodoFieldValues>) => onChange({ ...values, ...patch });
  const pickerBot = picker ? bots.find((bot) => bot.id === picker) : undefined;
  const when = values.when;

  return (
    <div data-todo-fields="" className="flex flex-col gap-2">
      <input ref={title} type="text" dir="auto" value={values.title} maxLength={TODO_TITLE_CHARS} aria-label={t("todo.fields.title")}
        placeholder={t("todo.fields.titlePlaceholder")} className={cn(FIELD, "w-full")}
        onChange={(event) => set({ title: event.target.value })}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && onSubmit) { event.preventDefault(); onSubmit(); } }} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-2 text-[13px] text-ink-secondary">
          {t("todo.fields.for")}
          <Select data-todo-bot="" value={values.botId ?? ""} onChange={(event) => set({ botId: event.target.value || null })} className="min-w-36">
            <option value="">{t("todo.fields.anyBot")}</option>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </Select>
        </label>
        <TodoWhenFields when={when} onChange={(next) => set({ when: next })} />
      </div>
      <textarea dir="auto" rows={2} value={values.note} maxLength={TODO_NOTE_CHARS} aria-label={t("todo.fields.note")}
        placeholder={t("todo.fields.notePlaceholder")} className={cn(FIELD, "h-auto min-h-9 w-full resize-y py-2")}
        onChange={(event) => set({ note: event.target.value })} />
      {!values.botId && (
        <p data-todo-picker-hint="" className="text-[12px] text-ink-tertiary">
          {pickerBot ? t("todo.fields.pickerPicks", { bot: pickerBot.name }) : t("todo.fields.youPick")}
        </p>
      )}
      {when.kind === "repeat" && <p className="text-[12px] text-ink-tertiary">{t("todo.fields.repeatHint")}</p>}
    </div>
  );
}

/** The start rule control: a menu of rules, and the time or days a rule needs. */
export function TodoWhenFields({ when, onChange, allowRepeat = true }: { when: TodoWhen; onChange: (when: TodoWhen) => void; allowRepeat?: boolean }) {
  const names = weekdayNames("narrow");
  return (
    <>
        <label className="flex min-w-0 items-center gap-2 text-[13px] text-ink-secondary">
          {t("todo.fields.when")}
          <Select data-todo-when="" value={when.kind} onChange={(event) => onChange(whenFor(event.target.value as TodoWhen["kind"], when))} className="min-w-36">
            <option value="free">{t("todo.when.free")}</option>
            <option value="tomorrow">{t("todo.fields.tomorrow")}</option>
            <option value="at">{t("todo.fields.pickTime")}</option>
            {allowRepeat && <option value="repeat">{t("todo.fields.repeats")}</option>}
          </Select>
        </label>
        {when.kind === "at" && (
          <input type="datetime-local" value={when.at} aria-label={t("todo.fields.time")} className={FIELD}
            onChange={(event) => onChange({ ...when, at: event.target.value })} />
        )}
        {when.kind === "repeat" && (
          <>
            <input type="time" value={when.time} aria-label={t("todo.fields.time")} className={FIELD}
              onChange={(event) => onChange({ ...when, time: event.target.value })} />
            <div role="group" aria-label={t("todo.fields.days")} className="flex gap-1">
              {MONDAY_FIRST.map((day) => {
                const on = when.weekdays.includes(day);
                return (
                  <button key={day} type="button" aria-pressed={on} data-todo-day={day}
                    onClick={() => onChange({ ...when, weekdays: on ? when.weekdays.filter((one) => one !== day) : [...when.weekdays, day] })}
                    className={cn("size-8 rounded-full text-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus motion-reduce:transition-none",
                      on ? "bg-ink/[0.14] text-ink" : "text-ink-secondary hover:bg-ink/[0.06]")}>
                    {names[day]}
                  </button>
                );
              })}
            </div>
          </>
        )}
    </>
  );
}
