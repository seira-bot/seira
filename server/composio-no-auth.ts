import type { AppConfig } from "./config.ts";
import { listToolkits } from "./composio.ts";
import { canonicalToolkitSlug } from "./composio-project.ts";

interface ServiceStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
}

/**
 * An app the catalog says needs no sign-in counts as connected. Its status can come back empty, and a client such as the
 * phone app offers Connect for every app that is not connected, which fails with "does not require authentication".
 * The catalog is read only when some app has no status; a catalog that cannot be read leaves the status as it was.
 */
export async function includeNoAuthServices<State extends ServiceStatus>(
  cfg: AppConfig,
  status: Record<string, State>,
): Promise<Record<string, State>> {
  const open = Object.keys(status).filter((slug) => !status[slug]!.connected && !status[slug]!.pending);
  if (!open.length) return status;
  const included = await listToolkits(cfg)
    .then(({ cards }) => new Set(cards.filter((card) => card.noAuth).map((card) => card.slug)))
    .catch(() => new Set<string>());
  const needless = open.filter((slug) => included.has(canonicalToolkitSlug(slug)));
  if (!needless.length) return status;
  return { ...status, ...Object.fromEntries(needless.map((slug) => [slug, { ...status[slug]!, connected: true, status: "ACTIVE" }])) };
}

/**
 * The status Settings shows. Connect cards settle on the status the connector service reported, before the catalog adds
 * anything: an app that needs no sign-in has no account, so it must not mark a card waiting for one as connected or
 * resume the turn parked on it. Only the HTTP response carries the catalog's addition.
 */
export async function connectorStatusForSettings<State extends ServiceStatus>(
  cfg: AppConfig,
  reported: Record<string, State>,
  settleCards?: (reported: Record<string, State>) => unknown,
): Promise<Record<string, State>> {
  settleCards?.(reported);
  return includeNoAuthServices(cfg, reported);
}
