import { useEffect, useSyncExternalStore } from "react";

import { reserveConnectionPage } from "@/lib/connector-oauth";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";
import {
  DEFAULT_GITHUB_BOT_POLICY,
  GITHUB_APP_API,
  GITHUB_REPO_LEVELS,
  normalizeGithubCompletionCode,
  type GithubAccount,
  type GithubAppStatus,
  type GithubBotPolicy,
  type GithubConnectStart,
  type GithubRepo,
  type GithubRepoGrant,
  type GithubRepoLevel,
} from "../../shared/github-app";

/** The GitHub mark on a dark tile, as a data address so it shows with no request. */
export const GITHUB_LOGO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#0d1117"/><path transform="translate(8 8) scale(1.5)" fill="#fff" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
)}`;

export const GITHUB_CARD = { logo: GITHUB_LOGO, domain: null, label: "GitHub" } as const;

/** What the Apps search box matches for the GitHub tile. */
export const GITHUB_CARD_SEARCH = "github git code repository repositories issues pull requests";

interface GithubStore {
  status: GithubAppStatus | null;
  phase: "idle" | "loading" | "ready" | "failed";
  /** A connect that opened GitHub and has not finished: `accounts` is how many accounts and requests there were then. */
  waiting: { url: string; codeEntry: boolean; accounts: number } | null;
  manageUrl: string | null;
  /** A connect that this app started has just finished; the card reads it once and clears it. */
  justLinked: boolean;
}

let store: GithubStore = { status: null, phase: "idle", waiting: null, manageUrl: null, justLinked: false };
let loading: Promise<void> | null = null;
const watchers = new Set<() => void>();

function update(next: Partial<GithubStore>): void {
  store = { ...store, ...next };
  for (const watch of Array.from(watchers)) watch();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

function isStatus(value: unknown): value is GithubAppStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<GithubAppStatus>;
  return typeof status.enabled === "boolean" && Array.isArray(status.accounts) && Array.isArray(status.pending)
    && typeof status.bots === "object" && status.bots !== null;
}

function size(status: GithubAppStatus): number {
  return status.accounts.length + status.pending.length;
}

function take(value: unknown): GithubAppStatus {
  if (!isStatus(value)) throw new Error(t("github.error"));
  const grew = store.waiting !== null && size(value) > store.waiting.accounts;
  update({ status: value, phase: "ready", waiting: grew ? null : store.waiting, ...(grew ? { justLinked: true } : {}) });
  return value;
}

/** Reads the connection once, and again when `force` is set. A server without the feature leaves the state failed, which hides every GitHub control. */
export function loadGithubApp(force = false): Promise<void> {
  if (loading) return loading;
  if (!force && (store.phase === "ready" || store.phase === "failed")) return Promise.resolve();
  if (store.phase === "idle") update({ phase: "loading" });
  loading = api(GITHUB_APP_API)
    .then((answer) => { take(answer); })
    .catch(() => { if (!store.status) update({ phase: "failed" }); })
    .finally(() => { loading = null; });
  return loading;
}

export function resetGithubApp(): void {
  loading = null;
  store = { status: null, phase: "idle", waiting: null, manageUrl: null, justLinked: false };
  for (const watch of Array.from(watchers)) watch();
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export async function connectGithub(): Promise<GithubConnectStart> {
  const start = await api<GithubConnectStart>(`${GITHUB_APP_API}/connect`, json("POST", {}));
  if (!start || typeof start.url !== "string") throw new Error(t("github.error"));
  update({ waiting: { url: start.url, codeEntry: start.codeEntry === true, accounts: store.status ? size(store.status) : 0 }, manageUrl: null });
  return start;
}

/** Reserves the browser page during the click, asks for the link and opens it. `opened` is false when the browser blocked the page. */
export async function openGithubConnect(): Promise<GithubConnectStart & { opened: boolean }> {
  const launch = reserveConnectionPage();
  try {
    const start = await connectGithub();
    return { ...start, opened: await launch.open(start.url) };
  } finally {
    launch.cancel();
  }
}

export class GithubCodeError extends Error {
  constructor() {
    super(t("github.codeInvalid"));
  }
}

export async function completeGithub(raw: string): Promise<GithubAppStatus> {
  const code = normalizeGithubCompletionCode(raw);
  if (!code) throw new GithubCodeError();
  const status = take(await api(`${GITHUB_APP_API}/complete`, json("POST", { code })));
  update({ waiting: null, justLinked: true });
  return status;
}

export async function refreshGithub(): Promise<GithubAppStatus> {
  return take(await api(`${GITHUB_APP_API}/refresh`, json("POST", {})));
}

/** `null` takes the bot off GitHub. */
export async function setGithubBotPolicy(botId: string, policy: GithubBotPolicy | null): Promise<GithubAppStatus> {
  return take(await api(`${GITHUB_APP_API}/bots/${encodeURIComponent(botId)}`, json("PUT", policy)));
}

/** The address where the person removes Seira on GitHub itself, once the account is no longer linked. */
export async function removeGithubAccount(installationId: number): Promise<string | null> {
  const answer = await api<{ manageUrl?: unknown; status?: unknown }>(`${GITHUB_APP_API}/accounts/${installationId}`, json("DELETE"));
  take(answer?.status);
  const manageUrl = typeof answer?.manageUrl === "string" && answer.manageUrl ? answer.manageUrl : null;
  update({ manageUrl });
  return manageUrl;
}

export async function disconnectGithub(): Promise<GithubAppStatus> {
  return take(await api(GITHUB_APP_API, json("DELETE")));
}

export function clearGithubJustLinked(): void {
  if (store.justLinked) update({ justLinked: false });
}

export function dismissGithubManageLink(): void {
  update({ manageUrl: null });
}

export function useGithubApp({ load = true, watchConnect = false }: { load?: boolean; watchConnect?: boolean } = {}) {
  const snapshot = useSyncExternalStore(subscribe, () => store, () => store);
  useEffect(() => {
    if (load) void loadGithubApp();
  }, [load]);
  const waiting = snapshot.waiting !== null;
  useEffect(() => {
    if (!watchConnect || !waiting) return;
    const back = () => {
      if (document.visibilityState === "hidden") return;
      void refreshGithub().catch(() => {});
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [watchConnect, waiting]);
  const status = snapshot.status?.enabled === true ? snapshot.status : null;
  return {
    status,
    phase: snapshot.phase,
    waiting: snapshot.waiting,
    manageUrl: snapshot.manageUrl,
    justLinked: snapshot.justLinked,
    clearJustLinked: clearGithubJustLinked,
    reload: () => loadGithubApp(true),
  };
}

export const githubOwnerName = (status: Pick<GithubAppStatus, "ownerLabel">): string => status.ownerLabel?.trim() || t("github.ownerFallback");

export const githubLevelLabel = (level: GithubRepoLevel): string =>
  t(level === "read" ? "github.level.read" : level === "pull_requests" ? "github.level.pullRequests" : "github.level.write");

export const githubLevelHint = (level: GithubRepoLevel): string =>
  t(level === "read" ? "github.levelHint.read" : level === "pull_requests" ? "github.levelHint.pullRequests" : "github.levelHint.write");

export const githubRepoCount = (count: number): string => t(count === 1 ? "github.repoCount.one" : "github.repoCount.other", { count });

export function githubHighestLevel(repos: readonly GithubRepoGrant[]): GithubRepoLevel | null {
  let best = -1;
  for (const grant of repos) best = Math.max(best, GITHUB_REPO_LEVELS.indexOf(grant.level));
  return best < 0 ? null : GITHUB_REPO_LEVELS[best]!;
}

/** "3 repositories · Pull requests", "Read in 1 repository" or "No repositories yet". */
export function githubBotHint(policy: GithubBotPolicy | undefined): string {
  const level = policy ? githubHighestLevel(policy.repos) : null;
  if (!policy || !level) return t("github.hint.none");
  if (policy.repos.length === 1) return t("github.hint.one", { level: githubLevelLabel(level) });
  return t("github.hint.many", { count: policy.repos.length, level: githubLevelLabel(level) });
}

export const githubPolicyFor = (status: GithubAppStatus | null, botId: string): GithubBotPolicy | undefined => status?.bots[botId];

export function githubBotsUsing<B extends Pick<Bot, "id">>(status: GithubAppStatus | null, bots: readonly B[]): B[] {
  return bots.filter((bot) => githubPolicyFor(status, bot.id) !== undefined);
}

export const githubGrantKey = (grant: Pick<GithubRepoGrant, "installationId" | "repositoryId">): string => `${grant.installationId}:${grant.repositoryId}`;

export function githubFindRepo(status: GithubAppStatus, grant: Pick<GithubRepoGrant, "installationId" | "repositoryId">): { account: GithubAccount; repo: GithubRepo } | null {
  const account = status.accounts.find((candidate) => candidate.installationId === grant.installationId);
  const repo = account?.repositories.find((candidate) => candidate.id === grant.repositoryId);
  return account && repo ? { account, repo } : null;
}

export const githubWithLevel = (policy: GithubBotPolicy, target: GithubRepoGrant, level: GithubRepoLevel): GithubBotPolicy => ({
  ...policy,
  repos: policy.repos.map((grant) => (githubGrantKey(grant) === githubGrantKey(target) ? { ...grant, level } : grant)),
});

export const githubWithoutRepo = (policy: GithubBotPolicy, target: GithubRepoGrant): GithubBotPolicy => ({
  ...policy,
  repos: policy.repos.filter((grant) => githubGrantKey(grant) !== githubGrantKey(target)),
});

/** New repositories start at Read. */
export function githubWithRepos(policy: GithubBotPolicy, added: readonly { installationId: number; repo: GithubRepo }[]): GithubBotPolicy {
  const have = new Set(policy.repos.map(githubGrantKey));
  const fresh = added
    .filter(({ installationId, repo }) => !have.has(githubGrantKey({ installationId, repositoryId: repo.id })))
    .map(({ installationId, repo }): GithubRepoGrant => ({ installationId, repositoryId: repo.id, fullName: repo.fullName, level: "read" }));
  return { ...policy, repos: [...policy.repos, ...fresh] };
}

export const githubTurnedOn = (): GithubBotPolicy => ({ ...DEFAULT_GITHUB_BOT_POLICY, repos: [] });
