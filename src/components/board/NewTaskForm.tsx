import { useEffect, useRef, useState, type FormEvent } from "react";

import { t } from "@/lib/i18n";
import { createBoardTask } from "@/state/board";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { BotMenu } from "./BotMenu";

export function NewTaskForm({ bots, defaultBotId }: { bots: readonly Bot[]; defaultBotId: string | null }) {
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const botId = (chosen && bots.some((bot) => bot.id === chosen) ? chosen : null) ?? defaultBotId;
  const bot = bots.find((one) => one.id === botId);
  useEffect(() => { input.current?.focus(); }, []);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const body = text.trim();
    if (!body || !botId || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await createBoardTask(botId, body);
      setText("");
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} data-board-new-task="" className="space-y-2 px-4 pb-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="text" dir="auto" value={text} onChange={(event) => setText(event.target.value)} aria-label={t("board.newTask")}
          placeholder={t("board.newTask.placeholder", { bot: bot?.name ?? "" })}
          className="h-9 min-w-48 flex-1 rounded-lg bg-inset px-3 text-[13px] text-ink shadow-[inset_0_0_0_0.5px_var(--color-edge)] placeholder:text-ink-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" />
        <BotMenu label={t("board.newTask.bot")} bots={bots} value={botId} onChange={(id) => setChosen(id)}
          summary={<>{bot && <BotAvatar bot={bot} size={18} label="" />}<span className="min-w-0 truncate">{bot?.name}</span></>} />
        <button type="submit" disabled={!text.trim() || !botId || sending}
          className="h-9 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-ink transition-colors duration-150 hover:opacity-90 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
          {t("board.newTask.send")}
        </button>
      </div>
      <p role="alert" className="flex items-center gap-2 text-[13px] text-danger empty:hidden">
        {failed && <>{t("board.newTask.failed")}<button type="button" className="font-medium underline" onClick={() => void submit()}>{t("board.retry")}</button></>}
      </p>
    </form>
  );
}
