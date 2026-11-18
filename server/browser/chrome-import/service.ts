import type { ImportCookie, SignedInSite, SignedInSites } from "../../browser-sites.ts";
import { readCookieRows, readHostSummaries } from "./cookie-db.ts";
import { decryptCookies } from "./decrypt.ts";
import { chromeImportErrors } from "./errors.ts";
import { loadKeys, wipeKeys, type KeyDeps } from "./keys.ts";
import { detectProfiles, type BrowserProfile, type DetectDeps } from "./profiles.ts";
import { groupSites, type SensitiveLabel } from "./sites.ts";
import { createTicketStore, type TicketStore } from "./tickets.ts";

export type { SensitiveLabel } from "./sites.ts";
export { ChromeImportError } from "./errors.ts";
export type { ImportCookie } from "../../browser-sites.ts";

/** One browser profile the owner can import from. */
export interface ChromeProfileSummary {
  id: string;
  name: string;
  browserName: string;
  lastUsed: boolean;
}

/** One site of a profile. It never carries a cookie name, a cookie value or a raw host. */
export interface ChromeImportSite {
  site: string;
  cookies: number;
  sensitive: SensitiveLabel | null;
  suggested: boolean;
}

export interface ChromeImportListing {
  /** Single use, valid for five minutes, bound to the caller that asked. */
  ticket: string;
  profileName: string;
  browserName: string;
  sites: ChromeImportSite[];
}

export interface ChromeImportInput {
  ticket: string;
  caller: string;
  /** Sites of the ticket's listing. */
  sites: string[];
  /** Puts the decrypted cookies into the target browser and answers with the sites it now holds. */
  write: (cookies: ImportCookie[]) => Promise<SignedInSites>;
}

export interface ChromeImportResult {
  imported: { sites: number; cookies: number };
  /** Expired cookies and cookies that could not be opened. */
  skipped: number;
  running: boolean;
  sites: SignedInSite[];
}

export interface ChromeImportDeps extends DetectDeps, KeyDeps {
  /** Milliseconds since 1970. */
  now?: () => number;
  tickets?: TicketStore;
  /** Where private copies of cookie databases are made. */
  tmpRoot?: string;
}

export interface ChromeImportService {
  profiles(): Promise<ChromeProfileSummary[]>;
  sites(profileId: string, caller: string): Promise<ChromeImportListing>;
  run(input: ChromeImportInput): Promise<ChromeImportResult>;
}

export function createChromeImportService(deps: ChromeImportDeps = {}): ChromeImportService {
  const now = deps.now ?? Date.now;
  const tickets = deps.tickets ?? createTicketStore(now);
  const database = { tmpRoot: deps.tmpRoot };
  const nowUnix = () => Math.floor(now() / 1000);

  function profileById(profileId: string): BrowserProfile {
    const profile = detectProfiles(deps).find((candidate) => candidate.id === profileId);
    if (!profile) throw chromeImportErrors.unknownProfile();
    if (profile.tooLarge) throw chromeImportErrors.tooLarge();
    return profile;
  }

  function unreadable<T>(read: () => T): T {
    try { return read(); } catch { throw chromeImportErrors.unreadable(); }
  }

  return {
    async profiles() {
      return detectProfiles(deps).map(({ id, name, browserName, lastUsed }) => ({ id, name, browserName, lastUsed }));
    },

    async sites(profileId, caller) {
      const profile = profileById(profileId);
      const grouped = groupSites(unreadable(() => readHostSummaries(profile.cookiesPath, nowUnix(), database)));
      const ticket = tickets.issue({ caller, profileId, sites: new Map(grouped.map((entry) => [entry.site, entry.hostKeys])) });
      return {
        ticket,
        profileName: profile.name,
        browserName: profile.browserName,
        sites: grouped.map(({ site, cookies, sensitive, suggested }) => ({ site, cookies, sensitive, suggested })),
      };
    },

    async run(input) {
      const ticket = tickets.take(input.ticket, input.caller);
      if (!ticket) throw chromeImportErrors.badTicket();
      const chosen = [...new Set(input.sites)];
      if (chosen.length === 0 || chosen.some((site) => !ticket.sites.has(site))) throw chromeImportErrors.badSite();
      const siteOfHost = new Map(chosen.flatMap((site) => ticket.sites.get(site)!.map((hostKey) => [hostKey, site] as const)));
      const profile = profileById(ticket.profileId);
      const { version, rows } = unreadable(() => readCookieRows(profile.cookiesPath, [...siteOfHost.keys()], nowUnix(), database));
      const keys = await loadKeys(profile.browser, deps);
      try {
        const decrypted = decryptCookies(rows, keys, version, nowUnix());
        if (keys.fromKeyring === 0 && decrypted.cookies.length === 0 && decrypted.failed > 0) throw chromeImportErrors.noKey();
        const written = await input.write(decrypted.cookies);
        const importedSites = new Set(decrypted.cookies.map((cookie) => siteOfHost.get(cookie.domain)));
        return {
          imported: { sites: importedSites.size, cookies: decrypted.cookies.length },
          skipped: decrypted.expired + decrypted.failed,
          running: written.running,
          sites: written.sites,
        };
      } finally { wipeKeys(keys); }
    },
  };
}
