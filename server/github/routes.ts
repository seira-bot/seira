import { createServer, type Server } from "node:http";
import type { IncomingMessage } from "node:http";

import {
  GITHUB_APP_API,
  normalizeGithubCompletionCode,
  type GithubAccount,
  type GithubAppStatus,
  type GithubBotPolicy,
  type GithubConnectStart,
} from "../../shared/github-app.ts";
import type { AppConfig } from "../config.ts";
import { githubAppEnabled } from "./flag.ts";
import { isLoopbackHost, isProxied, requestSource, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { GithubBrokerError, type GithubBrokerClient } from "./broker-client.ts";
import { canConnect, isConnectionOwner, requesterKey, requesterLabel } from "./owner.ts";
import { githubPolicyWidens } from "./policy.ts";
import { githubBotPolicySchema, type GithubStore, type GithubStoreData } from "./store.ts";

export const GITHUB_RETURN_PATH = "/github/return";
export const GITHUB_LISTENER_TIMEOUT_MS = 15 * 60_000;

export interface GithubRouteDeps {
  cfg(): Pick<AppConfig, "features" | "profile">;
  env?: NodeJS.ProcessEnv;
  store: GithubStore;
  broker: GithubBrokerClient;
  botExists(botId: string): boolean;
  botVisible(auth: RequestAuth, botId: string): boolean;
  desktopManaged: boolean;
  anyBotBusy(): boolean;
  now?: () => number;
  listenerTimeoutMs?: number;
}

interface Requester { key: string; label: string }

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function resultPage(ok: boolean): string {
  const text = ok
    ? "GitHub is connected. You can close this tab and go back to Seira."
    : "GitHub was not connected. Go back to Seira and try again.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seira</title></head><body style="font-family:system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem"><p>${escapeHtml(text)}</p></body></html>`;
}

const remoteBrowser = (req: IncomingMessage, auth: RequestAuth) =>
  auth.kind === "session" && (isProxied(req) || !isLoopbackHost(req.headers.host));

const BUSY_WIDEN_REFUSAL = "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle.";

export function createGithubRoutes(deps: GithubRouteDeps): RouteHandler {
  const { store, broker } = deps;
  const now = deps.now ?? Date.now;
  let listener: { server: Server; timer: NodeJS.Timeout } | null = null;

  const enabled = () => githubAppEnabled(deps.cfg(), deps.env);
  const profileName = () => deps.cfg().profile?.name;

  function statusFor(auth: RequestAuth): GithubAppStatus {
    const data = store.read();
    const canEdit = canConnect(auth, data);
    const bots = Object.fromEntries(Object.entries(data.bots).filter(([id]) => deps.botExists(id) && deps.botVisible(auth, id)));
    const status = {
      enabled: true,
      connected: data.accounts.length > 0,
      canEdit,
      ownedByYou: isConnectionOwner(auth, data),
      ...(data.ownerLabel ? { ownerLabel: data.ownerLabel } : {}),
      bots,
    };
    if (canEdit) return { ...status, accounts: data.accounts, pending: data.pending };
    const used = new Set(Object.values(bots).flatMap((policy) => policy.repos.map((grant) => `${grant.installationId}:${grant.repositoryId}`)));
    const accounts = data.accounts.map((account) => ({
      ...account,
      repositories: account.repositories.filter((repo) => used.has(`${account.installationId}:${repo.id}`)),
      repositoryCount: account.repositories.length,
    }));
    return { ...status, accounts, pending: [] };
  }

  const stripGrants = (data: GithubStoreData, keep: (installationId: number, repositoryId: number) => boolean) => {
    for (const policy of Object.values(data.bots)) policy.repos = policy.repos.filter((repo) => keep(repo.installationId, repo.repositoryId));
  };

  async function refresh(): Promise<void> {
    const found = await broker.installations();
    const accounts: GithubAccount[] = found.installations.map((one) => ({
      installationId: one.id,
      login: one.account.login,
      type: one.account.type,
      ...(one.account.avatarUrl ? { avatarUrl: one.account.avatarUrl } : {}),
      repositorySelection: one.repositorySelection,
      suspended: one.suspended,
      repositories: one.repositories,
    }));
    store.update((data) => {
      data.accounts = accounts;
      data.pending = found.pending.map((one) => ({ login: one.account }));
      const present = new Set(accounts.flatMap((account) => account.repositories.map((repo) => `${account.installationId}:${repo.id}`)));
      stripGrants(data, (installationId, repositoryId) => present.has(`${installationId}:${repositoryId}`));
      if (!data.accounts.length && !data.pending.length) clearOwner(data);
    });
  }

  function clearOwner(data: GithubStoreData): void {
    delete data.ownerKey;
    delete data.ownerLabel;
    delete data.connectedAt;
  }

  async function link(code: string, who: Requester): Promise<void> {
    const { linked } = await broker.complete(code);
    await refresh();
    store.update((data) => {
      if (data.ownerKey === undefined && (linked.length > 0 || data.accounts.length > 0)) {
        data.ownerKey = who.key;
        data.ownerLabel = who.label;
        data.connectedAt = now();
      }
    });
  }

  function closeListener(): void {
    if (!listener) return;
    clearTimeout(listener.timer);
    const { server } = listener;
    listener = null;
    server.close();
    server.closeAllConnections();
  }

  async function startListener(who: Requester): Promise<string> {
    closeListener();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, ok: boolean) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
        res.end(resultPage(ok));
      };
      if (req.method !== "GET" || url.pathname !== GITHUB_RETURN_PATH) {
        res.writeHead(404, { "cache-control": "no-store" });
        res.end();
        return;
      }
      const code = normalizeGithubCompletionCode(url.searchParams.get("code") ?? "");
      const finish = (status: number, ok: boolean) => {
        send(status, ok);
        if (listener?.server === server) closeListener();
      };
      if (!code) return finish(400, false);
      link(code, who).then(() => finish(200, true), () => finish(400, false));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const timer = setTimeout(() => { if (listener?.server === server) closeListener(); }, deps.listenerTimeoutMs ?? GITHUB_LISTENER_TIMEOUT_MS);
    timer.unref();
    listener = { server, timer };
    const address = server.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}${GITHUB_RETURN_PATH}`;
  }

  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== GITHUB_APP_API && !path.startsWith(`${GITHUB_APP_API}/`)) return PASS;
    if (!enabled()) {
      if (method === "GET" && path === GITHUB_APP_API) {
        return json(res, 200, { enabled: false, connected: false, canEdit: false, ownedByYou: false, accounts: [], pending: [], bots: {} } satisfies GithubAppStatus);
      }
      return json(res, 404, { error: "not found" });
    }

    const body = async (): Promise<{ ok: true; value: any } | { ok: false }> => {
      try { return { ok: true, value: await readBody(req) }; } catch { return { ok: false }; }
    };
    const brokerFailure = (error: unknown) => {
      if (error instanceof GithubBrokerError) return json(res, error.kind === "bad_code" ? 400 : 502, { error: error.message });
      throw error;
    };
    const ownerRefusal = () => {
      const label = store.read().ownerLabel ?? "the owner";
      return json(res, 403, { error: `Only ${label} can change GitHub access.` });
    };
    const owns = () => isConnectionOwner(auth, store.read());

    if (path === GITHUB_APP_API) {
      if (method === "GET") return json(res, 200, statusFor(auth));
      if (method === "DELETE") {
        if (!owns()) return ownerRefusal();
        try {
          for (const account of store.read().accounts) {
            try { await broker.unlink(account.installationId); } catch (error) { if (!(error instanceof GithubBrokerError && error.kind === "gone")) throw error; }
            store.update((data) => { data.accounts = data.accounts.filter((one) => one.installationId !== account.installationId); });
          }
        } catch (error) {
          return brokerFailure(error);
        }
        closeListener();
        store.write({ version: 1, accounts: [], pending: [], bots: {} });
        return json(res, 200, statusFor(auth));
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (path === `${GITHUB_APP_API}/refresh` && method === "POST") {
      try { await refresh(); } catch (error) { return brokerFailure(error); }
      return json(res, 200, statusFor(auth));
    }

    if (path === `${GITHUB_APP_API}/connect` && method === "POST") {
      if (!canConnect(auth, store.read())) return ownerRefusal();
      const key = requesterKey(auth);
      if (!key) return ownerRefusal();
      const who = { key, label: requesterLabel(auth, profileName()) };
      try {
        if (remoteBrowser(req, auth)) {
          const { url } = await broker.connect();
          return json(res, 200, { url, codeEntry: true } satisfies GithubConnectStart);
        }
        const returnTo = await startListener(who);
        try {
          const { url } = await broker.connect(returnTo);
          return json(res, 200, { url, codeEntry: false } satisfies GithubConnectStart);
        } catch (error) {
          closeListener();
          throw error;
        }
      } catch (error) {
        return brokerFailure(error);
      }
    }

    if (path === `${GITHUB_APP_API}/complete` && method === "POST") {
      if (!canConnect(auth, store.read())) return ownerRefusal();
      const key = requesterKey(auth);
      const read = await body();
      const raw = read.ok && read.value && typeof read.value.code === "string" ? read.value.code : "";
      const code = normalizeGithubCompletionCode(raw);
      if (!key || !code) return json(res, 400, { error: "That code is not valid. Check it and try again." });
      try { await link(code, { key, label: requesterLabel(auth, profileName()) }); } catch (error) { return brokerFailure(error); }
      return json(res, 200, statusFor(auth));
    }

    const ofBot = /^\/api\/github-app\/bots\/([\w-]+)$/.exec(path);
    if (ofBot && method === "PUT") {
      if (!owns()) return ownerRefusal();
      const botId = ofBot[1]!;
      const read = await body();
      if (!read.ok) return json(res, 400, { error: "The body must be JSON." });
      const data = store.read();
      if (deps.botExists(botId) && !deps.botVisible(auth, botId)) return json(res, 404, { error: "That bot does not exist." });
      if (read.value === null) {
        if (!deps.botExists(botId) && !data.bots[botId]) return json(res, 404, { error: "That bot does not exist." });
        store.update((next) => { delete next.bots[botId]; });
        return json(res, 200, statusFor(auth));
      }
      if (!deps.botExists(botId)) return json(res, 404, { error: "That bot does not exist." });
      const parsed = githubBotPolicySchema.safeParse(read.value);
      if (!parsed.success) return json(res, 400, { error: "That GitHub access is not valid." });
      const policy: GithubBotPolicy = { ...parsed.data, repos: [] };
      const seen = new Set<string>();
      for (const repo of parsed.data.repos) {
        const account = data.accounts.find((one) => one.installationId === repo.installationId);
        const known = account?.repositories.find((one) => one.id === repo.repositoryId);
        if (!known) return json(res, 400, { error: "One of the repositories is not connected." });
        const key = `${repo.installationId}:${repo.repositoryId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        policy.repos.push({ installationId: repo.installationId, repositoryId: repo.repositoryId, fullName: known.fullName, level: repo.level });
      }
      // Outside the packaged desktop a loopback caller is the owner, and a bot's own shell can forge any header.
      if (auth.kind === "loopback" && !deps.desktopManaged && githubPolicyWidens(data.bots[botId], policy)) {
        if (deps.anyBotBusy()) return json(res, 409, { error: BUSY_WIDEN_REFUSAL });
        console.warn(`bot ${botId}: GitHub access widened by ${requestSource(req)} through the local API with no paired session`);
      }
      store.update((next) => { next.bots[botId] = policy; });
      return json(res, 200, statusFor(auth));
    }
    if (ofBot) return json(res, 405, { error: "method not allowed" });

    const ofAccount = /^\/api\/github-app\/accounts\/(\d{1,15})$/.exec(path);
    if (ofAccount && method === "DELETE") {
      if (!owns()) return ownerRefusal();
      const installationId = Number(ofAccount[1]);
      if (!store.read().accounts.some((account) => account.installationId === installationId)) return json(res, 404, { error: "That account is not connected." });
      let manageUrl = "";
      try {
        manageUrl = (await broker.unlink(installationId)).manageUrl;
      } catch (error) {
        if (!(error instanceof GithubBrokerError && error.kind === "gone")) return brokerFailure(error);
      }
      store.update((data) => {
        data.accounts = data.accounts.filter((account) => account.installationId !== installationId);
        stripGrants(data, (id) => id !== installationId);
        if (!data.accounts.length && !data.pending.length) clearOwner(data);
      });
      await refresh().catch(() => {});
      return json(res, 200, { manageUrl, status: statusFor(auth) });
    }

    return json(res, 404, { error: "not found" });
  };
}
