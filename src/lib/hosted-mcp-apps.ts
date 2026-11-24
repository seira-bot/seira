import { MessageCircle, type LucideIcon } from "lucide-react";

import biverLogo from "@/assets/biver/logo.png";
import citcatLogo from "@/assets/citcat/logo.png";
import coretLogo from "@/assets/coret/logo.png";
import dalektaLogo from "@/assets/dalekta/logo.png";
import grupyLogo from "@/assets/grupy/logo.png";
import konektorLogo from "@/assets/konektor/logo.png";
import replizLogo from "@/assets/repliz/logo.png";
import termiloLogo from "@/assets/termilo/logo.png";
import type { LocaleKey } from "@/locales";

export interface HostedMcpApp {
  /** The card's id (`data-app-tile`) and the name the server is added under (then `-2`, `-3`…): a valid server name. */
  readonly id: string;
  /** The service's own name, never translated. */
  readonly label: string;
  /** Its official hosted MCP endpoint. A server is this app only at exactly this address, over streamable HTTP. */
  readonly url: string;
  /** Its licensed logo, or a neutral lucide glyph when the service publishes none we may ship. */
  readonly icon: { readonly image: string } | { readonly glyph: LucideIcon };
  readonly description: LocaleKey;
  /** What signing in grants, and who owns the service's own approvals. Shown on the card and on the server's row. */
  readonly notice: LocaleKey;
  /** Search words besides the label and the description. */
  readonly keywords: string;
  /** True for a service that can read and send as the person: Connect asks which bot gets it, and shows what it can do,
   * before sign-in. The server is then that one bot's own, never every bot's. */
  readonly perBot?: true;
}

/** The hosted MCP apps with a one-click card in Plugins. Adding one is adding a row: its card, Connect, Disconnect and
 * Bot access, its row in the MCP list, search, the Connected filter and the count all derive from this table. */
export const HOSTED_MCP_APPS = [
  {
    id: "konektor",
    label: "Konektor.id",
    url: "https://mcp.konektor.id/mcp",
    icon: { image: konektorLogo },
    description: "konektor.description",
    notice: "konektor.notice",
    keywords: "konektor whatsapp leads inbox broadcast ads conversions tracking crm",
  },
  {
    id: "biver",
    label: "Biver.id",
    url: "https://mcp.biver.id/mcp",
    icon: { image: biverLogo },
    description: "biver.description",
    notice: "biver.notice",
    keywords: "biver website landing page builder pages sections forms products checkout domain",
  },
  {
    id: "coret",
    label: "Coret.id",
    url: "https://mcp.coret.id/mcp",
    icon: { image: coretLogo },
    description: "coret.description",
    notice: "coret.notice",
    keywords: "coret mind map mindmap whiteboard sketch notes pad book share",
  },
  {
    id: "termilo",
    label: "Termilo.id",
    url: "https://api.termilo.id/mcp",
    icon: { image: termiloLogo },
    description: "termilo.description",
    notice: "termilo.notice",
    keywords: "termilo booking appointment schedule calendar reservation customers services",
  },
  {
    id: "citcat",
    label: "Citcat.id",
    url: "https://api-crm.citcat.id/api/mcp",
    icon: { image: citcatLogo },
    description: "citcat.description",
    notice: "citcat.notice",
    keywords: "citcat whatsapp crm inbox chats contacts customers sales funnel leads instagram messenger line",
  },
  {
    id: "repliz",
    label: "Repliz",
    url: "https://mcp.repliz.com/mcp",
    icon: { image: replizLogo },
    description: "repliz.description",
    notice: "repliz.notice",
    keywords: "repliz social media comments auto reply dm schedule posts automation instagram facebook threads tiktok youtube",
  },
  {
    id: "dalekta",
    label: "Dalekta",
    url: "https://mcp.dalekta.id/mcp",
    icon: { image: dalektaLogo },
    description: "dalekta.description",
    notice: "dalekta.notice",
    keywords: "dalekta whatsapp ctwa lpwa ads tracking leads closing revenue conversions capi meta funnel",
  },
  {
    id: "grupy",
    label: "Grupy.chat",
    url: "https://mcp.grupy.chat/mcp",
    icon: { image: grupyLogo },
    description: "grupy.description",
    notice: "grupy.notice",
    keywords: "grupy whatsapp group groups community summary summaries recap members export join requests approval",
  },
  {
    id: "wapilot",
    label: "WAPilot",
    url: "https://integrator.wapilot.id/v1/mcp",
    icon: { glyph: MessageCircle },
    description: "wapilot.description",
    notice: "wapilot.notice",
    perBot: true,
    keywords: "wapilot whatsapp web chrome extension send messages chats contacts groups auto reply broadcast reminder template catalog knowledge guardrails",
  },
] as const satisfies readonly HostedMcpApp[];

/** Whether Connect must first ask which bot gets this app. */
export const hostedPerBot = (app: HostedMcpApp | undefined): boolean => app?.perBot === true;

/** A row of the table, with its own literal id. */
export type HostedApp = (typeof HOSTED_MCP_APPS)[number];
export type HostedMcpAppId = HostedApp["id"];

export type HostedConnections = Readonly<Record<HostedMcpAppId, boolean>>;

interface ServerAddress { type?: string; url?: string }

/** The hosted app this server is, by exact address: type "http", https, the app's origin, its path with or without a
 * trailing slash, no query, hash or userinfo. A look-alike host or a URL carrying a key is never branded. */
export function hostedMcpApp(server: ServerAddress): HostedApp | undefined {
  if (server.type !== "http" || !server.url) return undefined;
  let address: URL;
  try { address = new URL(server.url); } catch { return undefined; }
  if (address.search || address.hash || address.username || address.password) return undefined;
  return HOSTED_MCP_APPS.find((app) => {
    const own = new URL(app.url);
    return address.origin === own.origin && (address.pathname === own.pathname || address.pathname === `${own.pathname}/`);
  });
}

/** `biver`, then `biver-2`, `biver-3`…: never an existing server's name. */
export function hostedServerName(app: HostedMcpApp, servers: ReadonlyArray<{ name: string }>): string {
  const names = new Set(servers.map((server) => server.name));
  let name: string = app.id;
  for (let suffix = 2; names.has(name); suffix++) name = `${app.id}-${suffix}`;
  return name;
}

export const HOSTED_KEY_HEADER = "Authorization";

/** True when the server holds an `Authorization` header, such as a pasted key. */
export function holdsHostedKey(server: { headerKeys?: readonly string[] }): boolean {
  return server.headerKeys?.some((name) => name.toLowerCase() === HOSTED_KEY_HEADER.toLowerCase()) === true;
}

/** The one rule for "connected", shared by the cards, the Connected filter and the count: the server is on and signed
 * in or holds an `Authorization` header. */
export function hostedConnections(
  servers: ReadonlyArray<ServerAddress & { enabled: boolean; auth?: "signed-in" | "needs-sign-in"; headerKeys?: readonly string[] }>,
): HostedConnections {
  return Object.fromEntries(HOSTED_MCP_APPS.map((app) => [
    app.id,
    servers.some((server) => hostedMcpApp(server) === app && server.enabled && (server.auth === "signed-in" || holdsHostedKey(server))),
  ])) as HostedConnections;
}

/** A server of the person's own: a hosted app's server shows as that app's card instead. */
export function ownMcpServer(server: ServerAddress & { name: string }): boolean {
  return server.url === undefined || !hostedMcpApp(server);
}

/** The one rule for "connected" for such a server: on, and signed in if it takes a sign-in. */
export function mcpServerConnected(server: { enabled: boolean; auth?: "signed-in" | "needs-sign-in" }): boolean {
  return server.enabled && server.auth !== "needs-sign-in";
}
