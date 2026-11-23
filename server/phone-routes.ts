import { qrEndpoints, type CompanionEndpoint } from "../shared/pairing-link.ts";

const TAILNET_SUFFIX = ".ts.net";

export interface PhoneRouteSources {
  publicUrl: string | null;
  tailnetOrigin: string | null;
  customDomain: string | null;
  extra?: readonly string[];
}

export interface PhoneRoutes {
  /** Every https route, tailnet first, then the own domain, then the rest. */
  endpoints: CompanionEndpoint[];
  /** The route a link opens first: the first one that is not a tailnet name, so a plain browser reaches it. */
  primary: string | null;
}

/** `SEIRA_PHONE_ROUTES`: comma-separated https origins that the serving process adds to the phone routes. */
export function phoneRoutesFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env.SEIRA_PHONE_ROUTES ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

const isTailnetRoute = (url: string): boolean => new URL(url).hostname.toLowerCase().endsWith(TAILNET_SUFFIX);

export function phoneRoutes({ publicUrl, tailnetOrigin, customDomain, extra = [] }: PhoneRouteSources): PhoneRoutes {
  const candidates: CompanionEndpoint[] = [];
  for (const value of [tailnetOrigin, ...extra, customDomain, publicUrl]) {
    if (!value) continue;
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol === "https:") candidates.push({ url: parsed.origin, kind: "hosted", priority: 0 });
    } catch {
      continue;
    }
  }
  const valid = qrEndpoints(candidates.map((endpoint, index) => ({ ...endpoint, priority: index })));
  const ordered = [...valid.filter((endpoint) => isTailnetRoute(endpoint.url)), ...valid.filter((endpoint) => !isTailnetRoute(endpoint.url))];
  const endpoints = ordered.map((endpoint, priority) => ({ ...endpoint, priority }));
  const primary = endpoints.find((endpoint) => !isTailnetRoute(endpoint.url)) ?? endpoints[0];
  return { endpoints, primary: primary?.url ?? null };
}
