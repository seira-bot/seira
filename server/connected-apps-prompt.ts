import { describeConnectorScopes, type ConnectorScopes } from "../shared/connector-scopes.ts";
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
  return composioSystemPrompt(bot.connectorTools) + describeConnectorScopes(bot.connectorScopes);
}
