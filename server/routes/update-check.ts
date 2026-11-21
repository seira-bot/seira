// GET /api/updates/check: whether a newer version exists, and how this install is updated. Read-only, so client sessions may ask.
// GET and POST /api/updates/server: the Update server button, for an admin's session only (server/server-update.ts).
import type { IncomingMessage } from "node:http";

import type { AdminActor } from "../admin-activity.ts";
import { serverVersion } from "../environment.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import type { RequestAuth } from "../request-auth.ts";
import { loadConfig, saveConfig } from "../config.ts";
import { readAppState, runningCopy } from "../app-update.ts";
import { startAutoUpdate } from "../auto-update.ts";
import { createServerUpdater, SERVER_UPDATE_DIR, SERVER_UPDATE_DIR_ENV, type ServerUpdater } from "../server-update.ts";
import { createUpdateChecker, installKind, updateChannel, type UpdateCheck } from "../update-check.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UpdateCheckRouteDeps {
  check(): Promise<UpdateCheck>;
  server?: ServerUpdater;
  actor?(auth: RequestAuth, req: IncomingMessage): AdminActor;
}

/** SECURITY: a person's admin session, never loopback: on a server, loopback is a bot's shell or a process beside it. This
 * guards the button only. The request file it leaves is in a folder of the server's user, so until the bots' sandbox is
 * on for self-hosted servers anything running as that user, a bot included, can leave it too; what that can cause is
 * only the standard update (server/server-update.ts). */
export function mayUpdateServer(auth: RequestAuth): boolean {
  return auth.kind === "session" && auth.scopes.includes("admin");
}

export function createUpdateCheckRoutes(deps: UpdateCheckRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, auth, readBody }) => {
    if (path === "/api/updates/server/auto" && deps.server && method === "POST") {
      if (!mayUpdateServer(auth)) return json(res, 403, { error: "Only an admin of this server, signed in, can change this.", code: "admin_only" });
      const body = await readBody(req, 1_024).catch(() => null) as { on?: unknown } | null;
      if (typeof body?.on !== "boolean") return json(res, 400, { error: "Send on as true or false." });
      return json(res, 200, await deps.server.setAuto(body.on, deps.actor?.(auth, req) ?? { kind: "loopback" }));
    }
    if (path === "/api/updates/server" && deps.server && (method === "GET" || method === "POST")) {
      if (!mayUpdateServer(auth)) return json(res, 403, { error: "Only an admin of this server, signed in, can update it.", code: "admin_only" });
      if (method === "GET") return json(res, 200, await deps.server.status());
      const done = await deps.server.request(deps.actor?.(auth, req) ?? { kind: "loopback" });
      return json(res, done.status, done.body);
    }
    if (path !== "/api/updates/check" || method !== "GET") return PASS;
    try {
      return json(res, 200, await deps.check());
    } catch (error) {
      return json(res, 502, { error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
}

export function serverUpdateChecker(where: { desktopManaged: boolean; managed: boolean }): () => Promise<UpdateCheck> {
  return createUpdateChecker({ current: serverVersion(), install: installKind({ ...where, serverRoot: SERVER_ROOT }), channel: updateChannel() });
}

/** A launcher started this server, and it can read the server's version from the health check to judge a new copy. */
export function launcherCanRestart(env: NodeJS.ProcessEnv, loopbackOwner: boolean): boolean {
  return env.SEIRA_LAUNCHER === "1" && loopbackOwner;
}

/** Both routes' parts for this server: one shared check, and the button where the install has one. */
export function updateRouteDeps(where: {
  desktopManaged: boolean;
  managed: boolean;
  dataDir: string;
  activeTurns(): number;
  actor(auth: RequestAuth, req: IncomingMessage): AdminActor;
  /** Asks the server to stop with the restart exit code, which its launcher answers by starting the new copy. */
  restart(): void;
  /** False when the launcher's health check cannot read the version of this server (loopback trust for a service). */
  loopbackOwner: boolean;
  /** False in a test, so no timer starts. */
  schedule?: boolean;
}): UpdateCheckRouteDeps {
  const install = installKind({ ...where, serverRoot: SERVER_ROOT });
  const channel = updateChannel();
  const check = createUpdateChecker({ current: serverVersion(), install, channel });
  const dir = process.env[SERVER_UPDATE_DIR_ENV]?.trim() || (install === "docker" ? SERVER_UPDATE_DIR : undefined);
  const server = createServerUpdater({
    dir, dataDir: where.dataDir, install, version: serverVersion(), check, activeTurns: where.activeTurns, followsStable: channel === "stable",
    app: { launched: launcherCanRestart(process.env, where.loopbackOwner), restart: () => { setTimeout(where.restart, 1_000); }, running: runningCopy(where.dataDir, process.argv[1]) },
    auto: { admin: () => loadConfig().updates?.auto !== false, save: (on) => saveConfig({ updates: { auto: on } }) },
  });
  if (where.schedule !== false) startAutoUpdate({ status: () => server.status(), request: (actor) => server.request(actor), now: () => new Date(), failed: () => readAppState(where.dataDir).failed });
  return { check, server, actor: where.actor };
}
