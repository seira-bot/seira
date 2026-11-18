import type { HostSummary } from "./cookie-db.ts";

export type SensitiveLabel = "identity" | "email" | "financial";

export interface GroupedSite {
  site: string;
  /** Raw host keys stay inside the server; they never reach a response. */
  hostKeys: string[];
  cookies: number;
  sensitive: SensitiveLabel | null;
  suggested: boolean;
  lastAccess: number;
}

const MAX_SUGGESTED = 5;

const IDENTITY = [
  "okta.com", "oktapreview.com", "okta-emea.com", "onelogin.com", "auth0.com", "duosecurity.com", "pingidentity.com", "pingone.com",
  "microsoftonline.com", "live.com", "microsoft.com", "office.com", "apple.com", "icloud.com", "1password.com", "1password.eu",
  "1password.ca", "lastpass.com", "bitwarden.com", "dashlane.com", "keepersecurity.com",
];
const EMAIL = [
  "google.com", "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "ymail.com", "proton.me", "protonmail.com",
  "fastmail.com", "hey.com", "zoho.com", "icloud.com",
];
const FINANCIAL = /bank|banque|banco|(^|[.-])(chase|wellsfargo|citi|hsbc|barclays|schwab|fidelity|vanguard|etrade|robinhood|coinbase|kraken|binance|paypal|venmo|wise|revolut|monzo|stripe|brex|ramp|mercury|amex|americanexpress|capitalone|discover|sofi|ally|bca|bri|bni|mandiri|ovo|dana|gopay|jenius)([.-]|$)/u;

const inDomain = (site: string, domain: string) => site === domain || site.endsWith(`.${domain}`);

export function sensitivityOf(site: string): SensitiveLabel | null {
  if (IDENTITY.some((domain) => inDomain(site, domain))) return "identity";
  if (EMAIL.some((domain) => inDomain(site, domain))) return "email";
  return FINANCIAL.test(site) ? "financial" : null;
}

function bareHost(hostKey: string): string {
  return hostKey.replace(/^\./u, "").toLowerCase();
}

export function validHost(host: string): boolean {
  if (!/^[a-z0-9.-]+$/u.test(host)) return false;
  if (/^\d+(\.\d+){3}$/u.test(host)) return false;
  return host !== "localhost" && !/\.(local|localhost|internal)$/u.test(host);
}

/** A host joins the widest domain-wide cookie that covers it; without one it is its own site, minus a leading `www.`. */
function siteOf(host: string, domainHosts: ReadonlySet<string>): string {
  const labels = host.split(".");
  for (let count = 2; count <= labels.length; count += 1) {
    const candidate = labels.slice(-count).join(".");
    if (domainHosts.has(candidate)) return candidate;
  }
  return host.replace(/^www\./u, "");
}

export function groupSites(summaries: readonly HostSummary[]): GroupedSite[] {
  const valid = summaries.filter((summary) => validHost(bareHost(summary.hostKey)));
  const domainHosts = new Set(valid.filter((summary) => summary.hostKey.startsWith(".")).map((summary) => bareHost(summary.hostKey)));
  const sites = new Map<string, GroupedSite & { authShaped: boolean }>();
  for (const summary of valid) {
    const site = siteOf(bareHost(summary.hostKey), domainHosts);
    let entry = sites.get(site);
    if (!entry) sites.set(site, entry = { site, hostKeys: [], cookies: 0, sensitive: sensitivityOf(site), suggested: false, lastAccess: 0, authShaped: false });
    entry.hostKeys.push(summary.hostKey);
    entry.cookies += summary.cookieCount;
    entry.authShaped ||= summary.hasAuthShaped;
    entry.lastAccess = Math.max(entry.lastAccess, summary.lastAccess);
  }
  const grouped = [...sites.values()];
  grouped
    .filter((entry) => entry.sensitive === null && entry.authShaped)
    .sort((a, b) => b.lastAccess - a.lastAccess || a.site.localeCompare(b.site))
    .slice(0, MAX_SUGGESTED)
    .forEach((entry) => { entry.suggested = true; });
  return grouped
    .map(({ authShaped: _authShaped, ...entry }) => entry)
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.lastAccess - a.lastAccess || a.site.localeCompare(b.site));
}
