import { importIntoSites, listSignedInSites, signOutOfSites } from "../browser-sites.ts";
import { createChromeImportService, type ChromeImportService } from "../browser/chrome-import/service.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BrowserSitesRouteDeps } from "../routes/browser-sites.ts";

export interface BrowserSitesHostDeps {
  target: BrowserSitesRouteDeps["target"];
  /** The server runs on the owner's own computer, not on a Cloud home or in a hosted workspace. */
  local: boolean;
  owner(auth: RequestAuth): boolean;
  platform?: NodeJS.Platform;
  service?: ChromeImportService;
}

export function createBrowserSitesHost(deps: BrowserSitesHostDeps): BrowserSitesRouteDeps {
  const platform = deps.platform ?? process.platform;
  const service = deps.service ?? createChromeImportService();
  return {
    target: deps.target,
    list: (target) => listSignedInSites(target),
    signOut: (target, site) => signOutOfSites(target, site),
    chromeImport: {
      enabled: () => deps.local && (platform === "linux" || platform === "darwin"),
      owner: (auth) => deps.owner(auth),
      caller: (auth) => (auth.kind === "session" ? `session:${auth.session.id}` : "loopback"),
      service,
      write: (target) => (cookies) => importIntoSites(target, cookies),
    },
  };
}
