import { parsePackageDocument } from "../../shared/package-format";
import { appSwitchPatch } from "@/lib/bot-app-access";
import { hasActiveConnection, type ConnectorStatus } from "@/lib/connector-status";
import type { Action, Bot } from "@/state/store";

export interface ImportApp {
  slug: string;
  label: string;
}

export function requiredAppsOf(source: unknown): ImportApp[] {
  try {
    return parsePackageDocument(source).package.requirements.apps.map(({ slug, label }) => ({ slug, label }));
  } catch {
    return [];
  }
}

export function connectedApps(apps: readonly ImportApp[], services: Record<string, ConnectorStatus>): ImportApp[] {
  return apps.filter((app) => hasActiveConnection(services[app.slug]));
}

/** Gives the chosen apps to the bots an import just made (each starts with its apps off). Pass only bots that can use apps. */
export function grantImportedApps(
  bots: readonly Bot[],
  slugs: readonly string[],
  dispatch: (action: Action) => void,
): void {
  if (!slugs.length) return;
  for (const bot of bots) {
    let current: Bot = bot;
    let patch: Partial<Bot> = {};
    for (const slug of slugs) {
      const next = appSwitchPatch(current, slugs, slug, true) as Partial<Bot>;
      current = { ...current, ...next };
      patch = { ...patch, ...next };
    }
    if (Object.keys(patch).length > 0) dispatch({ type: "updateBot", botId: bot.id, patch });
  }
}
