import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import {
  dismissGithubManageLink, GITHUB_CARD, githubBotsUsing, githubOwnerName, githubRepoCount, openGithubConnect,
  removeGithubAccount, useGithubApp,
} from "@/lib/github-app";
import { t } from "@/lib/i18n";
import { botAppScope } from "@/lib/bot-app-access";
import { useStore } from "@/state/store";
import type { GithubAccount } from "../../shared/github-app";
import { GITHUB_APP_SLUG } from "../../shared/github-app";
import { BotAvatar } from "./Avatar";
import { botsForApps } from "./AppGrantPrompt";
import { openBotSettings } from "./bot-panel/panel-link";
import { ConfirmDialog } from "./ConfirmDialog";
import { GithubCodeForm } from "./GithubCodeForm";
import { ServiceIcon } from "./ServiceIcon";

const pill = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40";

/** The GitHub card in Apps: the person signs in with GitHub and picks repositories, with no key to paste. */
export function GithubCard({ onChange }: {
  /** Opens the "Which bots can use GitHub?" dialog. */
  onChange: () => void;
}) {
  const { state, dispatch } = useStore();
  const github = useGithubApp({ watchConnect: true });
  const { status, waiting, manageUrl, justLinked, clearJustLinked } = github;
  const [busy, setBusy] = useState<"connect" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<GithubAccount | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const ownsConnection = status !== null && status.canEdit && status.ownedByYou;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!justLinked || !ownsConnection) return;
    clearJustLinked();
    onChangeRef.current();
  }, [justLinked, ownsConnection, clearJustLinked]);

  if (!status) return null;
  const bots = botsForApps(state.bots, state.instances);
  const usedBy = githubBotsUsing(status, bots).filter((bot) => botAppScope(bot, GITHUB_APP_SLUG) !== null);
  const usedByLabel = t("apps.usedBy", { names: usedBy.map((bot) => bot.name).join(", ") });
  const owner = githubOwnerName(status);
  const editable = status.canEdit && (status.ownedByYou || !status.connected);
  const description = t("github.description");

  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setError(null);
    setBlockedUrl(null);
    try {
      const start = await openGithubConnect();
      if (!start.opened && mounted.current) setBlockedUrl(start.url);
    } catch {
      if (mounted.current) setError(t("github.error"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const remove = async (account: GithubAccount) => {
    setBusy("remove");
    setError(null);
    try {
      await removeGithubAccount(account.installationId);
    } catch {
      if (mounted.current) setError(t("github.error"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const manageBot = (botId: string) => {
    dispatch({ type: "togglePlugins", open: false });
    openBotSettings(dispatch, "access", { botId, page: status.bots[botId] ? "github" : "apps" });
  };

  return (
    <div data-app-tile="github" data-github-state={status.connected ? "connected" : "idle"} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <ServiceIcon card={GITHUB_CARD} className="size-10 shrink-0 rounded-[8px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{GITHUB_CARD.label}</span>
            {status.connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
            {usedBy.length > 0 && (
              <span className="ms-1 flex shrink-0 -space-x-1.5 rtl:space-x-reverse" title={usedByLabel} aria-label={usedByLabel} role="img">
                {usedBy.slice(0, 3).map((bot) => (
                  <span key={bot.id} data-used-by-avatar={bot.id} className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-menu ring-2 ring-menu">
                    <BotAvatar bot={bot} size={16} animated={false} />
                  </span>
                ))}
              </span>
            )}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={description}>{description}</p>
        </div>
        {editable && (
          <button type="button" disabled={busy !== null} onClick={() => void connect()} aria-label={status.connected ? undefined : t("github.connectAria")} className={pill}>
            {busy === "connect" ? <Loader2 size={14} className="animate-spin" /> : status.connected ? t("github.addAccount") : t("connectors.action.connect")}
          </button>
        )}
      </div>
      <div className="ps-[52px]">
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
        {blockedUrl && (
          <a href={blockedUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
            {t("github.openLink")}
          </a>
        )}
        {waiting?.codeEntry && <GithubCodeForm />}
        {status.connected && (
          <div data-app-bots="github_app" className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-5 text-ink-secondary">
            <span className="min-w-0 truncate" title={usedBy.length ? usedByLabel : undefined}>{usedBy.length ? usedByLabel : t("apps.usedByNone")}</span>
            {bots.length > 0 && (
              <button
                type="button"
                onClick={onChange}
                aria-label={t(editable ? "apps.whichBots" : "github.botsThatCan", { app: GITHUB_CARD.label })}
                className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-raised-hover"
              >
                {t(editable ? "apps.usedByChange" : "github.view")}
              </button>
            )}
          </div>
        )}
        {status.connected && (
          <div className="mt-1.5 space-y-0.5">
            {status.ownedByYou && <div className="text-[12px] leading-5 text-ink-tertiary">{t("github.connectedByYou")}</div>}
            {status.accounts.map((account) => (
              <div key={account.installationId} data-github-account={account.login} className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
                <span className="min-w-0 truncate text-ink">
                  {account.login}
                  <span className="text-ink-secondary"> · {githubRepoCount(account.repositoryCount ?? account.repositories.length)}</span>
                </span>
                {status.ownedByYou && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setLeaving(account)}
                    aria-label={t("github.disconnectAria", { login: account.login })}
                    className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    {t("connectors.disconnect")}
                  </button>
                )}
              </div>
            ))}
            {status.pending.map((request, index) => (
              <div key={`${request.login ?? "waiting"}:${index}`} data-github-pending className="flex min-w-0 flex-col text-[12px] leading-5">
                <span className="min-w-0 truncate text-ink">
                  {request.login ?? t("github.anOrganization")}
                  <span className="text-ink-secondary"> · <span className="text-warning">{t("github.waiting")}</span></span>
                </span>
                <span className="text-ink-tertiary">{t("github.pendingHint")}</span>
              </div>
            ))}
          </div>
        )}
        {status.connected && !status.ownedByYou && (
          <p data-github-readonly className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("github.memberNote", { owner })}</p>
        )}
        {manageUrl && status.ownedByYou && (
          <p className="mt-1.5 flex items-center gap-2 text-[12px] leading-5">
            <button type="button" onClick={() => void openExternalLink(manageUrl)} className="text-accent-text underline underline-offset-2">
              {t("github.removeOnGithub")}
            </button>
            <button type="button" onClick={dismissGithubManageLink} aria-label={t("common.close")} className="shrink-0 rounded-full px-1.5 text-ink-tertiary hover:text-ink">×</button>
          </p>
        )}
        <details className="mt-1 text-[12px] text-ink-secondary">
          <summary className="cursor-pointer">{t("github.access")}</summary>
          <p className="mt-2 leading-relaxed">{t("github.accessHint")}</p>
          <p className="mt-2 leading-relaxed">{t("github.accessOwnerOnly")}</p>
          {bots.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {bots.map((bot) => (
                <button key={bot.id} type="button" onClick={() => manageBot(bot.id)} className="rounded-lg bg-control px-2.5 py-1.5 text-ink hover:bg-raised-hover">
                  {t("github.manageBot", { name: bot.name })}
                </button>
              ))}
            </div>
          )}
        </details>
      </div>
      <ConfirmDialog
        open={leaving !== null}
        layer="z-[60]"
        tone="danger"
        title={t("connectors.disconnect")}
        confirmLabel={t("connectors.disconnect")}
        body={leaving ? t("github.disconnectBody", { login: leaving.login }) : ""}
        onCancel={() => setLeaving(null)}
        onConfirm={() => { const account = leaving; setLeaving(null); if (account) void remove(account); }}
      />
    </div>
  );
}
