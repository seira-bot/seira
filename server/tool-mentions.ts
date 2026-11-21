import { toolkitName } from "./activity.ts";
import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary.ts";

export type TurnTool = { name: string; kind: "app" | "mcp"; aliases: readonly string[] };
export type TaggedTool = { name: string; kind: "app" | "mcp" };

/** The tools a message @-tags. The longest name wins; a bot of the same length wins a tie, as in a bot tag. */
export function taggedTools(text: string, tools: readonly TurnTool[], botNames: readonly string[]): TaggedTool[] {
  const names = tools.flatMap((tool) => [tool.name, ...tool.aliases].filter((name) => name.trim()).map((name) => ({ tool, name })))
    .sort((a, b) => b.name.length - a.name.length);
  const found: TaggedTool[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1).toLowerCase();
    const matches = (name: string) => rest.startsWith(name.toLowerCase()) && !isMentionNameContinuation(rest.slice(name.length));
    const hit = names.find(({ name }) => matches(name));
    if (!hit) continue;
    if (botNames.some((name) => name.trim() && name.length >= hit.name.length && matches(name))) continue;
    if (!found.some((one) => one.name === hit.tool.name && one.kind === hit.tool.kind)) found.push({ name: hit.tool.name, kind: hit.tool.kind });
  }
  return found;
}

/** The sentence of the turn prompt that names the tools the person tagged. */
export function taggedToolsPrompt(tagged: readonly TaggedTool[]): string {
  if (!tagged.length) return "";
  const list = tagged.map((tool) => `${tool.name} (${tool.kind === "app" ? "a connected app" : "an MCP server"})`).join(", ");
  return `The person's message tags these tools: ${list}. They want them used for this request. If one fails, say so plainly.`;
}


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

/** Only a line the person typed in their own turn may name tools: never a webhook, a schedule, a relayed or peer line,
 * or a thread an outsider or a fence confines. */
export function toolMentionsAllowed(turn: {
  personLine: boolean;
  relayed?: boolean;
  unattended?: boolean;
  outside: boolean;
  guestConfined: boolean;
  fenced: boolean;
  botApi: boolean;
}): boolean {
  return turn.personLine && !turn.relayed && !turn.unattended && !turn.outside && !turn.guestConfined && !turn.fenced && !turn.botApi;
}
