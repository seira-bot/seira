import { describeConnectorScopes, type ConnectorScopes } from "../shared/connector-scopes.ts";
import { GITHUB_APP_SLUG } from "../shared/github-app.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";
import { APPS_OFF_CLAUSE } from "./setup-mode.ts";
import { composioSystemPrompt } from "./system-prompt.ts";

const NEVER_ASK = " Never ask the user for an API key, token, password or sign-in for an app such as Gmail, Google Drive or GitHub: it is not needed once Connected apps is on.";

export interface ConnectedAppsBot {
  composio?: boolean;
  connectorTools?: Record<string, ConnectorToolGrant>;
  connectorScopes?: ConnectorScopes;
}

/** `mounted` is whether this turn carries the apps tools; it defaults to a ready engine and host. */
export function connectedAppsPrompt(bot: ConnectedAppsBot, ready: { engine: boolean; configured: boolean; mounted?: boolean }): string {
  if (!ready.engine || !ready.configured) return "";
  if (bot.composio === false) return NEVER_ASK + APPS_OFF_CLAUSE;
  if (!(ready.mounted ?? true)) return "";
  return composioPart(bot.connectorTools) + scopesPart(bot.connectorScopes);
}

function without<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([slug]) => slug !== GITHUB_APP_SLUG));
}

function composioPart(grants: Record<string, ConnectorToolGrant> | undefined): string {
  if (!grants || !Object.hasOwn(grants, GITHUB_APP_SLUG)) return composioSystemPrompt(grants);
  const rest = without(grants);
  return Object.keys(rest).length === 0 ? "" : composioSystemPrompt(rest);
}

function scopesPart(scopes: ConnectorScopes | undefined): string {
  if (!scopes || !Object.hasOwn(scopes.apps, GITHUB_APP_SLUG)) return describeConnectorScopes(scopes);
  const apps = without(scopes.apps);
  if (Object.keys(apps).length === 0) return " This bot may use no other connected app.";
  return describeConnectorScopes({ ...scopes, apps, ...(scopes.accounts ? { accounts: without(scopes.accounts) } : {}) });
}
