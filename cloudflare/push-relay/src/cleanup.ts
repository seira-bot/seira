import { DAY_MS } from "./common";
import type { AppEnv } from "./env";
import { deleteInstallationStatements } from "./installations";

/** An installation that was not used for this long is deleted, with its credentials and tokens. */
export const INSTALLATION_IDLE_MS = 90 * DAY_MS;

export async function cleanup(env: AppEnv, now: number) {
  await env.DB.batch([
    ...deleteInstallationStatements(env, "last_seen_at < ?", now - INSTALLATION_IDLE_MS),
    env.DB.prepare("DELETE FROM installation_credentials WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?").bind(now - DAY_MS, now - DAY_MS),
    env.DB.prepare("DELETE FROM action_limits WHERE window_start < ?").bind(now - 2 * DAY_MS),
  ]);
}
