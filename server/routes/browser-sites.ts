// GET /api/browser-sites/import/profiles lists the computer's own browser profiles; POST /api/browser-sites/import/sites {profile | bot, source} lists one profile's sites and answers a single-use ticket; POST /api/browser-sites/import {profile | bot, ticket, sites} copies those sites' sign-ins into the bot browser. Only the computer's owner.
// GET ?profile=<id> or ?bot=<id>; POST /api/browser-sites/sign-out {profile | bot, site?} signs out of one site, or every site without `site`.
// On a Team Cloud `threadId` names the conversation whose browser is meant (a member's, a group chat's); none is the team's.
import type { BrowserSitesTarget, ImportCookie, SignedInSites } from "../browser-sites.ts";
import { ChromeImportError, type ChromeImportService } from "../browser/chrome-import/service.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type BrowserSitesRef = { profile: string } | { bot: string };

export interface BrowserSitesRouteDeps {
  target(ref: BrowserSitesRef, threadId: string | null): Promise<BrowserSitesTarget | { status: number; error: string }> | BrowserSitesTarget | { status: number; error: string };
  list(target: BrowserSitesTarget): Promise<SignedInSites>;
  signOut(target: BrowserSitesTarget, site: string | null): Promise<SignedInSites>;
  chromeImport?: {
    enabled(auth: RequestAuth): boolean;
    owner(auth: RequestAuth): boolean;
    /** A stable name for the requester, so a ticket works only for the one who asked. */
    caller(auth: RequestAuth): string;
    service: ChromeImportService;
    write(target: BrowserSitesTarget): (cookies: ImportCookie[]) => Promise<SignedInSites>;
  };
}

const IMPORT_PATHS = new Set(["/api/browser-sites/import/profiles", "/api/browser-sites/import/sites", "/api/browser-sites/import"]);
const TEXT_LIMIT = 256;
const SITE_LIMIT = 500;

const ID = /^[\w.-]{1,128}$/u;
const SITE = /^[a-z0-9.:[\]-]{1,253}$/u;
const threadOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

function ref(value: { profile?: unknown; bot?: unknown }): BrowserSitesRef | null {
  if (typeof value.profile === "string" && ID.test(value.profile) && value.bot === undefined) return { profile: value.profile };
  if (typeof value.bot === "string" && ID.test(value.bot) && value.profile === undefined) return { bot: value.bot };
  return null;
}

function failure(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not read this browser's sign-ins.";
}

export function createBrowserSiteRoutes(deps: BrowserSitesRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (IMPORT_PATHS.has(path)) {
      const gate = deps.chromeImport;
      const allowed = (path === "/api/browser-sites/import/profiles" ? method === "GET" : method === "POST");
      if (!allowed) return PASS;
      res.setHeader("cache-control", "no-store");
      if (!gate || !gate.enabled(auth)) return json(res, 404, { error: "Not found." });
      if (!gate.owner(auth)) return json(res, 403, { error: "Only this computer's owner can import sign-ins." });
      const refused = (error: unknown) => error instanceof ChromeImportError
        ? json(res, error.status, { error: error.message })
        : json(res, 503, { error: "Seira could not import these sign-ins. Try again." });
      if (path === "/api/browser-sites/import/profiles") {
        try { return json(res, 200, { profiles: await gate.service.profiles() }); }
        catch (error) { return refused(error); }
      }
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
      const body = await readBody(req, 16384);
      const which = body && typeof body === "object" ? ref(body) : null;
      if (!which) return json(res, 400, { error: "Name one browser profile or one bot." });
      const target = await deps.target(which, threadOf(body.threadId));
      if ("error" in target) return json(res, target.status, { error: target.error });
      try {
        const caller = gate.caller(auth);
        if (path === "/api/browser-sites/import/sites") {
          if (typeof body.source !== "string" || body.source.length === 0 || body.source.length > TEXT_LIMIT) return json(res, 400, { error: "Choose a browser profile from the list." });
          return json(res, 200, await gate.service.sites(body.source, caller));
        }
        const sites: unknown = body.sites;
        if (typeof body.ticket !== "string" || body.ticket.length === 0 || body.ticket.length > TEXT_LIMIT) return json(res, 400, { error: "Choose sites from the list." });
        if (!Array.isArray(sites) || sites.length === 0 || sites.length > SITE_LIMIT || !sites.every((site) => typeof site === "string" && SITE.test(site))) return json(res, 400, { error: "Choose sites from the list." });
        return json(res, 200, await gate.service.run({ ticket: body.ticket, caller, sites: sites as string[], write: gate.write(target) }));
      } catch (error) { return refused(error); }
    }
    if (path === "/api/browser-sites" && method === "GET") {
      const which = ref({ profile: url.searchParams.get("profile") ?? undefined, bot: url.searchParams.get("bot") ?? undefined });
      if (!which) return json(res, 400, { error: "Name one browser profile or one bot." });
      const target = await deps.target(which, threadOf(url.searchParams.get("threadId")));
      if ("error" in target) return json(res, target.status, { error: target.error });
      res.setHeader("cache-control", "no-store");
      try { return json(res, 200, await deps.list(target)); }
      catch (error) { return json(res, 503, { error: failure(error) }); }
    }
    if (path !== "/api/browser-sites/sign-out" || method !== "POST") return PASS;
    // JSON only, so a form posted from another local page cannot sign anyone out.
    const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
    const body = await readBody(req, 4096);
    const which = body && typeof body === "object" ? ref(body) : null;
    if (!which) return json(res, 400, { error: "Name one browser profile or one bot." });
    if (body.site !== undefined && (typeof body.site !== "string" || !SITE.test(body.site))) return json(res, 400, { error: "site must be a listed site" });
    const target = await deps.target(which, threadOf(body.threadId));
    if ("error" in target) return json(res, target.status, { error: target.error });
    try { return json(res, 200, await deps.signOut(target, body.site ?? null)); }
    catch (error) { return json(res, 503, { error: failure(error) }); }
  };
}
