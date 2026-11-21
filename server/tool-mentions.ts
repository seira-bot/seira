
/** The tools a turn can name: its connected apps (a slug and a label both name one) and its MCP servers. */
export function turnTools(apps: readonly { slug: string; label: string }[], mcpServers: readonly string[]): TurnTool[] {
  const appNames = new Set(apps.map((app) => app.label.toLowerCase()));
  return [
    ...apps.map((app) => ({ name: app.label, kind: "app" as const, aliases: [app.slug] })),
    ...mcpServers.filter((name) => !appNames.has(name.toLowerCase())).map((name) => ({ name, kind: "mcp" as const, aliases: [] })),
  ];
}

type ConnectedService = { connected?: boolean };
type TurnApp = { slug: string; label: string };

/** The connected apps a bot may use this turn: connected, and inside its scopes and tool grants. */
export function usableApps(
  bot: { connectorScopes?: { apps: Record<string, unknown> }; connectorTools?: Record<string, unknown> },
  services: Readonly<Record<string, ConnectedService>>,
  cards: readonly { slug: string; label: string }[],
): TurnApp[] {
  return Object.entries(services)
    .filter(([slug, state]) => state.connected && (!bot.connectorScopes || Object.hasOwn(bot.connectorScopes.apps, slug)) && (bot.connectorTools === undefined || Object.hasOwn(bot.connectorTools, slug)))
    .map(([slug]) => ({ slug, label: cards.find((card) => card.slug === slug)?.label ?? toolkitName(slug.toUpperCase()) }));
}

/** The prompt sentence for the tools a direct-chat message tags; empty in a room or when nothing is tagged. */
export async function taggedToolsFor(input: {
  text: string;
  direct: boolean;
  botNames: readonly string[];
  mcpServers: readonly string[];
  apps: (() => Promise<TurnApp[]>) | null;
}): Promise<string> {
  if (!input.direct || !input.text.includes("@")) return "";
  const apps = await input.apps?.().catch(() => []) ?? [];
  return taggedToolsPrompt(taggedTools(input.text, turnTools(apps, input.mcpServers), input.botNames));
}
