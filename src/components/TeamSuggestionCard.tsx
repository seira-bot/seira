// Seira's suggested team, under its line in the chat: the person edits the bots, creates the team or skips it, and the
// intro that follows names each bot's job and offers a first task. Nothing exists until Create team.
import { useMemo, useState } from "react";
import { Check, Loader2, Users } from "lucide-react";

import type { TeamIntro, TeamSuggestion } from "../../packages/phone-protocol/src/team-suggestion";
import { TEAM_BOT_NAME_MAX, TEAM_NAME_MAX } from "../../packages/phone-protocol/src/team-suggestion";
import { parsePackageDocument } from "../../shared/package-format";
import { packageDetails } from "../../shared/share-details";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Routine } from "@/lib/routines";
import { api, useStore, type Bot, type Group, type Message } from "@/state/store";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_FIELD, ASK_PRIMARY_BUTTON, ASK_SECONDARY_BUTTON } from "./AskCard";
import { TemplateFaces } from "./TemplateCard";

const FRAME = "w-full max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-[18px] bg-composer p-3 ring-[0.5px] ring-ink/10";

interface Draft {
  key: string;
  name: string;
  title: string;
  color: string;
}

function readDraft(suggestion: TeamSuggestion): { department: string; bots: Draft[]; chats: Array<{ name: string; members: string[] }> } | null {
  try {
    const document = parsePackageDocument(suggestion.document, { trust: "file" });
    const details = packageDetails(document);
    return {
      department: document.package.team?.name ?? details.name,
      bots: details.bots.map((bot) => ({ key: bot.key, name: bot.name, title: bot.description ?? bot.title ?? "", color: bot.color })),
      chats: (document.package.rooms ?? []).map((room) => ({ name: room.name, members: [...room.members] })),
    };
  } catch {
    return null;
  }
}

export function TeamBlocks({ message, botId, threadId }: { message: Message; botId: string; threadId: string }) {
  if (message.teamSuggestion) return <TeamSuggestionCard message={message} threadId={threadId} />;
  if (message.teamIntro) return <TeamIntroPart intro={message.teamIntro} botId={botId} threadId={threadId} />;
  return null;
}

const STATE_LINE = {
  created: "chat.teamCard.created",
  skipped: "chat.teamCard.skipped",
  replaced: "chat.teamCard.replaced",
} as const;

function TeamSuggestionCard({ message, threadId }: { message: Message; threadId: string }) {
  const { dispatch } = useStore();
  const allowed = useOwnerOrAdmin();
  const suggestion = message.teamSuggestion!;
  const read = useMemo(() => readDraft(suggestion), [suggestion]);
  const [department, setDepartment] = useState(read?.department ?? "");
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries((read?.bots ?? []).map((bot) => [bot.key, bot.name])));
  const [kept, setKept] = useState<Set<string>>(() => new Set((read?.bots ?? []).map((bot) => bot.key)));
  const [busy, setBusy] = useState<"create" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!read) return null;

  const open = suggestion.state === "open";
  const locked = !open || busy !== null;
  const canAct = allowed === true;
  const chats = read.chats.filter((chat) => chat.members.filter((key) => kept.has(key)).length >= 2);
  const nameOf = (key: string) => names[key]?.trim() || read.bots.find((bot) => bot.key === key)?.name || key;

  const settle = (state: "created" | "skipped") => dispatch({
    type: "messagePatched", threadId, message: { ...message, teamSuggestion: { ...suggestion, state } },
  });

  const create = async () => {
    setBusy("create");
    setError(null);
    try {
      // SAFETY: this endpoint is owned by the app and returns the created records.
      const result = (await api(`/api/teams/suggestion/${encodeURIComponent(message.id)}`, {
        method: "POST",
        body: JSON.stringify({ threadId, keep: [...kept], names, department: department.trim() || undefined }),
      })) as { bots?: Bot[]; groups?: Group[]; routines?: Routine[]; intro?: Message };
      for (const bot of result.bots ?? []) dispatch({ type: "botAdded", bot, preserveSelection: true });
      for (const group of result.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of result.routines ?? []) dispatch({ type: "routinePatched", routine });
      settle("created");
      if (result.intro) dispatch({ type: "messageAdded", threadId, message: result.intro });
      setBusy(null);
    } catch {
      setError(t("chat.teamCard.failed"));
      setBusy(null);
    }
  };

  const skip = async () => {
    setBusy("skip");
    setError(null);
    try {
      await api(`/api/teams/suggestion/${encodeURIComponent(message.id)}/skip`, { method: "POST", body: JSON.stringify({ threadId, keep: [] }) });
      settle("skipped");
      setBusy(null);
    } catch {
      setError(t("chat.teamCard.failed"));
      setBusy(null);
    }
  };

  const toggle = (key: string) => setKept((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <section data-team-card={message.id} data-state={suggestion.state} aria-label={t("chat.teamCard.title")} aria-busy={busy !== null || undefined} className={FRAME}>
      <div className="flex items-center gap-2">
        <TemplateFaces avatars={read.bots.filter((bot) => kept.has(bot.key)).map((bot) => ({ key: bot.key, name: nameOf(bot.key), color: bot.color }))} size={28} />
        <h3 dir="auto" className="min-w-0 flex-1 text-[16px] font-semibold leading-[22px] text-ink">{t("chat.teamCard.title")}</h3>
      </div>
      <label className="mt-2.5 block text-[13px] leading-[18px] text-ink-tertiary">
        {t("chat.teamCard.department")}
        <input value={department} maxLength={TEAM_NAME_MAX} disabled={locked || !canAct} onChange={(event) => setDepartment(event.target.value)}
          className={cn(ASK_FIELD, "mt-1 block w-full")} />
      </label>
      <ul className="mt-2 flex flex-col gap-1.5">
        {read.bots.map((bot) => (
          <li key={bot.key} className="flex items-start gap-2.5 rounded-[12px] px-1 py-1">
            <input type="checkbox" checked={kept.has(bot.key)} disabled={locked || !canAct} onChange={() => toggle(bot.key)}
              aria-label={t("chat.teamCard.keep", { name: nameOf(bot.key) })} className="mt-2 size-4 shrink-0 accent-[var(--accent)]" />
            <div className="min-w-0 flex-1">
              <input value={names[bot.key] ?? ""} maxLength={TEAM_BOT_NAME_MAX} disabled={locked || !canAct || !kept.has(bot.key)}
                aria-label={t("chat.teamCard.botName", { name: bot.name })}
                onChange={(event) => setNames((current) => ({ ...current, [bot.key]: event.target.value }))}
                className={cn(ASK_FIELD, "block w-full font-medium", !kept.has(bot.key) && "line-through")} />
              {bot.title && <p dir="auto" className="mt-0.5 break-words ps-3 text-[13px] leading-[18px] text-ink-tertiary">{bot.title}</p>}
            </div>
          </li>
        ))}
      </ul>
      {chats.length > 0 && (
        <p dir="auto" className="mt-2 break-words text-[13px] leading-[18px] text-ink-secondary">
          {t("chat.teamCard.chats", { chats: chats.map((chat) => `${chat.name} (${chat.members.filter((key) => kept.has(key)).map(nameOf).join(", ")})`).join("; ") })}
        </p>
      )}
      {open ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" data-team-create="" disabled={locked || !canAct || kept.size === 0} onClick={() => void create()} className={ASK_PRIMARY_BUTTON}>
            {busy === "create" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            {t("chat.teamCard.create")}
          </button>
          <button type="button" data-team-skip="" disabled={locked || !canAct} onClick={() => void skip()} className={ASK_SECONDARY_BUTTON}>
            {t("chat.teamCard.skip")}
          </button>
          {allowed === false && <p dir="auto" className="w-full text-[13px] leading-[18px] text-ink-tertiary">{t("chat.teamCard.adminOnly")}</p>}
        </div>
      ) : (
        <p data-team-state={suggestion.state} dir="auto" className="mt-3 text-[13px] leading-[18px] text-ink-tertiary">{t(STATE_LINE[suggestion.state as keyof typeof STATE_LINE])}</p>
      )}
      {error && <p role="alert" dir="auto" className="mt-2 text-[13px] leading-[18px] text-danger">{error}</p>}
    </section>
  );
}

function TeamIntroPart({ intro, botId, threadId }: { intro: TeamIntro; botId: string; threadId: string }) {
  const { dispatch } = useStore();
  const [sent, setSent] = useState(false);
  const send = () => {
    if (!intro.firstTask || sent) return;
    setSent(true);
    dispatch({ type: "send", botId, text: intro.firstTask, threadId });
  };
  return (
    <section data-team-intro="" aria-label={t("chat.teamIntro.title", { department: intro.department })} className={cn(FRAME, "mt-1.5")}>
      <div className="flex items-center gap-2">
        <Users size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <h3 dir="auto" className="min-w-0 flex-1 text-[15px] font-semibold leading-[22px] text-ink">{t("chat.teamIntro.title", { department: intro.department })}</h3>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {intro.bots.map((bot) => (
          <li key={bot.id} dir="auto" className="break-words text-[14px] leading-5 text-ink">
            <span className="font-medium">{bot.name}</span>{bot.job ? <span className="text-ink-secondary">{` - ${bot.job}`}</span> : null}
          </li>
        ))}
      </ul>
      <p dir="auto" className="mt-2 break-words text-[13px] leading-[18px] text-ink-tertiary">{t("chat.teamIntro.how")}</p>
      {intro.firstTask && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="text-[13px] leading-5 text-ink-tertiary">{t("chat.teamIntro.first")}</span>
          <button type="button" data-team-first-task="" disabled={sent} onClick={send} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>{intro.firstTask}</button>
        </div>
      )}
    </section>
  );
}
