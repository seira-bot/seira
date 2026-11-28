import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Plus } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  GITHUB_CARD, githubBotHint, githubFindRepo, githubLevelHint, githubLevelLabel, githubOwnerName, githubPolicyFor,
  githubTurnedOn, githubWithLevel, githubWithoutRepo, githubWithRepos, openGithubConnect, setGithubBotPolicy, useGithubApp,
} from "@/lib/github-app";
import { appSwitchPatch, botAppScope } from "@/lib/bot-app-access";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { GITHUB_APP_SLUG, GITHUB_REPO_LEVELS, type GithubAppStatus, type GithubBotPolicy, type GithubRepo, type GithubRepoGrant } from "../../../shared/github-app";
import { GithubCodeForm } from "../GithubCodeForm";
import { Card, LinkRow, NavRow, NoteRow, PageHeader, RadioRow, rowCls, RowText, SwitchRow } from "./rows";

const surface = "flex flex-col gap-3";
const noteCls = "mx-1 text-[13px] leading-normal text-ink-secondary";
const searchCls = "h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border";

/** What a person sees and may change: only the person who connected GitHub may change a bot's limits. */
export function useGithubEditing() {
  const { status } = useGithubApp();
  const owner = status ? githubOwnerName(status) : "";
  const editable = status !== null && status.canEdit && status.ownedByYou;
  return { status, editable, owner, reason: t("github.readOnlyShort", { owner }) };
}

/** Turns a bot on or off for GitHub, and gives it the app's scope when its apps are limited. */
export function useGithubBotSwitch(bot: Bot) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggle = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await setGithubBotPolicy(bot.id, on ? githubTurnedOn() : null);
      if (on && botAppScope(bot, GITHUB_APP_SLUG) === null) {
        const patch = appSwitchPatch(bot, [GITHUB_APP_SLUG], GITHUB_APP_SLUG, true);
        if (Object.keys(patch).length > 0) dispatch({ type: "updateBot", botId: bot.id, patch });
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, failed, toggle };
}

/** Under GitHub's switch in "Apps it can use": the repositories this bot may use. */
export function GithubRepositoriesRow({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const { status } = useGithubApp();
  const policy = githubPolicyFor(status, bot.id);
  if (!policy) return null;
  const names = policy.repos.map((grant) => grant.fullName.split("/").pop() ?? grant.fullName);
  return (
    <NavRow
      data-panel-page="github"
      title={t("github.repositories")}
      hint={names.length > 0 ? names.join(" · ") : githubBotHint(policy)}
      value={String(policy.repos.length)}
      onClick={onOpen}
    />
  );
}

type Screen = { kind: "bot" } | { kind: "repo"; grant: GithubRepoGrant } | { kind: "add" };

function repoMeta(status: GithubAppStatus, grant: GithubRepoGrant) {
  const found = githubFindRepo(status, grant);
  const [owner = grant.fullName, name = grant.fullName] = grant.fullName.split("/");
  return { name, owner, visibility: found ? t(found.repo.private ? "github.private" : "github.public") : null };
}

/** A bot's GitHub pages: its repositories, the level in each repository, and adding repositories. */
export function GithubBotFlow({ bot, backLabel, onExit }: { bot: Bot; backLabel: string; onExit: () => void }) {
  const { status, editable, owner, reason } = useGithubEditing();
  const [stack, setStack] = useState<Screen[]>([{ kind: "bot" }]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const screen = stack[stack.length - 1]!;
  const policy = githubPolicyFor(status, bot.id);
  const push = (next: Screen) => setStack((current) => [...current, next]);
  const pop = () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));

  const current = screen.kind === "repo" ? screen.grant : null;
  const grantGone = current !== null && policy !== undefined && !policy.repos.some((grant) => grant.installationId === current.installationId && grant.repositoryId === current.repositoryId);
  useEffect(() => {
    if (grantGone) pop();
  }, [grantGone]);

  const save = async (next: GithubBotPolicy): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setFailed(false);
    try {
      await setGithubBotPolicy(bot.id, next);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <NoteRow>{t("common.checking")}</NoteRow>;
  const errorNote = failed && <p role="alert" className="mx-1 text-[12px] text-danger">{t("github.error")}</p>;

  if (!policy) {
    return (
      <div data-github-page="off" className={surface}>
        <PageHeader back={backLabel} title={GITHUB_CARD.label} onBack={onExit} />
        <Card><NoteRow>{t("github.botOff", { name: bot.name })}</NoteRow></Card>
      </div>
    );
  }

  if (screen.kind === "repo") {
    const grant = policy.repos.find((entry) => entry.installationId === screen.grant.installationId && entry.repositoryId === screen.grant.repositoryId) ?? screen.grant;
    return (
      <div data-github-page="level" className={surface}>
        <PageHeader back={GITHUB_CARD.label} title={grant.fullName} onBack={pop} />
        <Card label={t("github.mayDo", { name: bot.name })}>
          {GITHUB_REPO_LEVELS.map((level) => (
            <RadioRow
              key={level}
              data-panel-choice={level}
              title={githubLevelLabel(level)}
              hint={githubLevelHint(level)}
              checked={grant.level === level}
              disabled={!editable || busy}
              onClick={() => { if (grant.level !== level) void save(githubWithLevel(policy, grant, level)); }}
            />
          ))}
          {editable && (
            <NavRow
              data-panel-row="remove-repo"
              title={t("github.removeFrom", { name: bot.name })}
              danger
              drill={false}
              disabled={busy}
              onClick={() => void save(githubWithoutRepo(policy, grant)).then((saved) => { if (saved) pop(); })}
            />
          )}
        </Card>
        {!editable && <p data-github-readonly className={noteCls}>{reason}</p>}
        {errorNote}
      </div>
    );
  }

  if (screen.kind === "add") {
    return <GithubAddRepos status={status} policy={policy} busy={busy} errorNote={errorNote} onBack={pop} onAdd={async (chosen) => { if (await save(githubWithRepos(policy, chosen))) pop(); }} />;
  }

  return (
    <div data-github-page="bot" className={surface}>
      <PageHeader back={backLabel} title={GITHUB_CARD.label} intro={t("github.botIntro", { name: bot.name })} onBack={onExit} />
      <Card label={t("github.repositories")}>
        {policy.repos.length === 0 && <NoteRow>{t("github.noRepos", { name: bot.name })}</NoteRow>}
        {policy.repos.map((grant) => {
          const meta = repoMeta(status, grant);
          return (
            <NavRow
              key={`${grant.installationId}:${grant.repositoryId}`}
              data-panel-row="repo"
              title={meta.name}
              hint={meta.visibility ? `${meta.owner} · ${meta.visibility}` : meta.owner}
              value={githubLevelLabel(grant.level)}
              onClick={() => push({ kind: "repo", grant })}
            />
          );
        })}
        {editable && <LinkRow data-panel-link="add-repos" icon={Plus} onClick={() => push({ kind: "add" })}>{t("github.addRepos")}</LinkRow>}
      </Card>
      <Card label={t("github.rules")}>
        <SwitchRow
          color={bot.color}
          title={t("github.askBig")}
          hint={t("github.askBigHint", { name: bot.name })}
          checked={policy.askBeforeBigChanges}
          disabled={!editable || busy}
          tooltip={editable ? undefined : reason}
          onChange={() => void save({ ...policy, askBeforeBigChanges: !policy.askBeforeBigChanges })}
        />
        <SwitchRow
          color={bot.color}
          title={t("github.ownBranches")}
          hint={t("github.ownBranchesHint", { name: bot.name })}
          checked={policy.ownBranchesOnly}
          disabled={!editable || busy}
          tooltip={editable ? undefined : reason}
          onChange={() => void save({ ...policy, ownBranchesOnly: !policy.ownBranchesOnly })}
        />
      </Card>
      <p data-github-readonly={editable ? undefined : ""} className={noteCls}>
        {editable ? t("github.ownerNote", { name: bot.name }) : t("github.memberBotNote", { owner, name: bot.name })}
      </p>
      {errorNote}
    </div>
  );
}

function GithubAddRepos({ status, policy, busy, errorNote, onBack, onAdd }: {
  status: GithubAppStatus;
  policy: GithubBotPolicy;
  busy: boolean;
  errorNote: React.ReactNode;
  onBack: () => void;
  onAdd: (chosen: { installationId: number; repo: GithubRepo }[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const { waiting } = useGithubApp();
  const added = new Set(policy.repos.map((grant) => `${grant.installationId}:${grant.repositoryId}`));
  const needle = query.trim().toLowerCase();
  const toggle = (key: string) => setChosen((currentSet) => {
    const next = new Set(currentSet);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const picked = status.accounts.flatMap((account) => account.repositories
    .filter((repo) => chosen.has(`${account.installationId}:${repo.id}`))
    .map((repo) => ({ installationId: account.installationId, repo })));

  const openGithub = async () => {
    if (opening) return;
    setOpening(true);
    setOpenFailed(false);
    setBlockedUrl(null);
    try {
      const start = await openGithubConnect();
      if (!start.opened) setBlockedUrl(start.url);
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div data-github-page="add" className={surface}>
      <PageHeader back={GITHUB_CARD.label} title={t("github.addRepos")} intro={t("github.addIntro")} onBack={onBack} />
      <Card>
        <div className={rowCls}>
          <input
            type="search"
            value={query}
            placeholder={t("github.searchRepos")}
            aria-label={t("github.searchRepos")}
            onChange={(event) => setQuery(event.target.value)}
            className={searchCls}
          />
        </div>
      </Card>
      {status.accounts.map((account) => {
        const repos = account.repositories.filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle));
        if (repos.length === 0) return null;
        return (
          <Card key={account.installationId} label={account.login}>
            {repos.map((repo) => {
              const key = `${account.installationId}:${repo.id}`;
              const isAdded = added.has(key);
              return (
                <label key={key} data-github-repo={repo.fullName} className={cn(rowCls, "cursor-pointer hover:bg-ink/[0.03]", isAdded && "cursor-default opacity-60")}>
                  <input
                    type="checkbox"
                    checked={isAdded || chosen.has(key)}
                    disabled={isAdded || busy}
                    onChange={() => toggle(key)}
                    className="size-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <RowText title={repo.name} hint={isAdded ? t("github.added") : t(repo.private ? "github.private" : "github.public")} />
                </label>
              );
            })}
          </Card>
        );
      })}
      <Card>
        <LinkRow data-panel-link="missing-repo" icon={opening ? Loader2 : ExternalLink} onClick={() => void openGithub()}>{t("github.missing")}</LinkRow>
        {waiting?.codeEntry && <div className={rowCls}><GithubCodeForm className="w-full" /></div>}
      </Card>
      {openFailed && <p role="alert" className="mx-1 text-[12px] text-danger">{t("github.error")}</p>}
      {blockedUrl && (
        <a href={blockedUrl} target="_blank" rel="noopener noreferrer" className="mx-1 text-[12px] text-accent-text underline underline-offset-2">
          {t("github.openLink")}
        </a>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={picked.length === 0 || busy}
          onClick={() => void onAdd(picked)}
          className="inline-flex h-9 items-center rounded-full bg-control px-4 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : t("github.addN", { count: picked.length })}
        </button>
      </div>
      {errorNote}
    </div>
  );
}

/** In Per-app tools, above GitHub's tool list: the repositories the tools work in, with the same pages as the bot panel. */
export function GithubRepositoriesBlock({ bot }: { bot: Bot }) {
  const { status, editable, owner } = useGithubEditing();
  const [open, setOpen] = useState(false);
  const policy = githubPolicyFor(status, bot.id);
  if (!status || !policy) return null;
  if (open) {
    return (
      <div data-github-block="flow" className="mb-3">
        <GithubBotFlow bot={bot} backLabel={t("github.pageTitle")} onExit={() => setOpen(false)} />
      </div>
    );
  }
  return (
    <div data-github-block="summary" className="mb-3">
      <div className="flex items-center gap-2">
        <div className="text-[12px] font-medium text-ink">{t("github.repositories")}</div>
        <button type="button" onClick={() => setOpen(true)} className="ms-auto rounded-full px-2 text-[12px] font-medium text-accent-text hover:bg-raised-hover">
          {editable ? t("apps.usedByChange") : t("github.view")}
        </button>
      </div>
      {policy.repos.length === 0 ? (
        <div className="mt-1 text-[12px] text-ink-secondary">{t("github.noRepos", { name: bot.name })}</div>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {policy.repos.map((grant) => (
            <li key={`${grant.installationId}:${grant.repositoryId}`} className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 truncate text-ink">{grant.fullName}</span>
              <span className="ms-auto shrink-0 text-ink-secondary">{githubLevelLabel(grant.level)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 text-[12px] text-ink-secondary">{t("github.toolsNote")}</div>
      {!editable && <div data-github-readonly className="mt-1 text-[12px] text-ink-secondary">{t("github.readOnlyShort", { owner })}</div>}
    </div>
  );
}
