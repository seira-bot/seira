import { useEffect, useMemo, useState } from "react";
import { api, type Bot } from "@/state/store";
import type { MentionChoice } from "@/components/MentionMenu";
import { loadAppCards, botAppsFrom, type BotApp } from "@/components/bot-settings/useBotApps";
import { useGithubApp } from "./github-app";
import { GITHUB_APP_SLUG } from "../../shared/github-app";
import { preloadConnectedApps, type ConnectorInventory } from "./connected-apps";
import type { ToolkitCard } from "../../shared/toolkit-card";
import type { EmailStatus } from "../../shared/email";

type ToolBot = Pick<Bot, "id" | "composio" | "connectorScopes" | "connectorTools">;
type McpEntry = { name: string; on: boolean };

const squash = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "");

/** Apps the bot may use, then the MCP servers that are on for it; an app and a server of one name make one row, the app's. */
export function mentionToolChoices(apps: readonly BotApp[], servers: readonly McpEntry[]): MentionChoice[] {
  const native = apps.some((app) => app.slug === GITHUB_APP_SLUG && app.scope !== null);
  const usable = apps.filter((app) => app.scope !== null && !(native && app.slug === "github"));
  const taken = new Set(usable.flatMap((app) => [squash(app.slug), squash(app.label)]));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const appRows: MentionChoice[] = usable.map((app) => ({
    id: `tool:app:${app.slug}`,
    name: app.label,
    tool: { kind: "app" as const, slug: app.slug, logo: app.card.logo, domain: app.card.domain, ...(app.blurb ? { blurb: app.blurb } : {}) },
  })).sort(byName);
  const mcpRows: MentionChoice[] = servers.filter((server) => server.on && !taken.has(squash(server.name))).map((server) => ({
    id: `tool:mcp:${server.name}`,
    name: server.name,
    tool: { kind: "mcp" as const, slug: server.name },
  })).sort(byName);
  return [...appRows, ...mcpRows];
}

type Loaded = {
  botId: string;
  inventory: ConnectorInventory | null;
  cards: ReadonlyMap<string, ToolkitCard>;
  email: EmailStatus | null;
  servers: McpEntry[];
};

const NO_COMPOSIO_APPS: ConnectorInventory = { services: {}, authoritative: true };

/** The tools of a bot for the @ list. Loads while the list is open and keeps the last answer for the bot. */
export function useMentionTools(bot: ToolBot | undefined, active: boolean): MentionChoice[] {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const botId = bot?.id;
  const github = useGithubApp({ load: active && Boolean(botId) }).status;
  useEffect(() => {
    if (!botId || !active) return;
    let cancelled = false;
    void Promise.all([
      preloadConnectedApps().catch(() => null),
      loadAppCards().catch(() => new Map<string, ToolkitCard>()),
      api("/api/email").then((result: EmailStatus) => result, () => null),
      api(`/api/bots/${botId}/mcp-servers`).then(
        (result: { servers?: Array<{ name?: unknown; on?: unknown }> }) => (result.servers ?? []).flatMap((server): McpEntry[] =>
          typeof server.name === "string" && server.on === true ? [{ name: server.name, on: true }] : []),
        () => [] as McpEntry[],
      ),
    ]).then(([inventory, cards, email, servers]) => {
      if (!cancelled) setLoaded({ botId, inventory, cards, email, servers });
    }).catch(() => {
      if (!cancelled) setLoaded({ botId, inventory: null, cards: new Map(), email: null, servers: [] });
    });
    return () => { cancelled = true; };
  }, [botId, active]);
  const composio = bot?.composio, connectorScopes = bot?.connectorScopes, connectorTools = bot?.connectorTools;
  return useMemo(() => {
    if (!botId || !loaded || loaded.botId !== botId) return [];
    const inventory = loaded.inventory?.authoritative ? loaded.inventory : NO_COMPOSIO_APPS;
    const apps = botAppsFrom({ id: botId, composio, connectorScopes, connectorTools }, inventory, loaded.cards, loaded.email, github).apps;
    return mentionToolChoices(apps, loaded.servers);
  }, [botId, loaded, composio, connectorScopes, connectorTools, github]);
}
