import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { BrowserSitesTarget } from "../browser-sites.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { ChromeImportError, type ChromeImportService } from "../browser/chrome-import/service.ts";
import { createBrowserSiteRoutes, type BrowserSitesRef, type BrowserSitesRouteDeps } from "./browser-sites.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve() {
  const asked: BrowserSitesRef[] = [];
  const threads: Array<string | null> = [];
  const signedOut: Array<{ session: string; site: string | null }> = [];
  const routes = [createBrowserSiteRoutes({
    target: (which, threadId) => {
      asked.push(which);
      threads.push(threadId);
      if ("bot" in which && which.bot === "guest-bot") return { status: 409, error: "A temporary browser saves no sign-ins." };
      return { binaryPath: "/engine", session: "bot-pepper", env: {}, encryptionKey: "k" } satisfies BrowserSitesTarget;
    },
    list: async () => ({ running: false, sites: [{ site: "example.com", cookies: 2, storage: 1 }] }),
    signOut: async (target, site) => { signedOut.push({ session: target.session, site }); return { running: true, sites: [] }; },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, type = "application/json") => fetch(`${base}/api/browser-sites/sign-out`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  return { base, asked, threads, signedOut, post };
}

describe("signed-in sites routes", () => {
  it("are for admins only, like the browser profiles", () => {
    expect(requiredScope("GET", "/api/browser-sites")).toBe("admin");
    expect(requiredScope("POST", "/api/browser-sites/sign-out")).toBe("admin");
  });

  it("list one profile's or one bot's sites", async () => {
    const { base, asked } = await serve();
    const response = await fetch(`${base}/api/browser-sites?profile=profile-work`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ running: false, sites: [{ site: "example.com", cookies: 2, storage: 1 }] });
    expect((await fetch(`${base}/api/browser-sites?bot=pepper`)).status).toBe(200);
    expect(asked).toEqual([{ profile: "profile-work" }, { bot: "pepper" }]);
  });

  it("need exactly one profile or bot, and pass the server's reason through", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/browser-sites`)).status).toBe(400);
    expect((await fetch(`${base}/api/browser-sites?profile=a&bot=b`)).status).toBe(400);
    const guest = await fetch(`${base}/api/browser-sites?bot=guest-bot`);
    expect(guest.status).toBe(409);
    expect(await guest.json()).toEqual({ error: "A temporary browser saves no sign-ins." });
  });

  it("sign out of one site, or of all when no site is named", async () => {
    const { post, signedOut } = await serve();
    expect((await post({ profile: "profile-work", site: "example.com" })).status).toBe(200);
    expect((await post({ bot: "pepper" })).status).toBe(200);
    expect(signedOut).toEqual([{ session: "bot-pepper", site: "example.com" }, { session: "bot-pepper", site: null }]);
  });

  it("refuse a form post, a bad site and a missing target", async () => {
    const { post, signedOut } = await serve();
    expect((await post({ profile: "profile-work" }, "text/plain")).status).toBe(415);
    expect((await post({ profile: "profile-work", site: "../../etc" })).status).toBe(400);
    expect((await post({ profile: "profile-work", site: 7 })).status).toBe(400);
    expect((await post({ site: "example.com" })).status).toBe(400);
    expect(signedOut).toEqual([]);
  });
});

describe("signed-in sites of one conversation's browser on a Team Cloud", () => {
  it("name the conversation for the server to find its audience's browser, and nothing without one", async () => {
    const { base, threads, post } = await serve();
    expect((await fetch(`${base}/api/browser-sites?bot=pepper&threadId=ada-chat`)).status).toBe(200);
    expect((await fetch(`${base}/api/browser-sites?bot=pepper`)).status).toBe(200);
    expect((await post({ bot: "pepper", threadId: "ada-chat", site: "example.com" })).status).toBe(200);
    expect((await post({ bot: "pepper" })).status).toBe(200);
    expect(threads).toEqual(["ada-chat", null, "ada-chat", null]);
  });
});

describe("Chrome import routes", () => {
  const calls: string[] = [];
  const written: unknown[] = [];
  const spy = (fail?: Error): ChromeImportService => ({
    profiles: async () => { calls.push("profiles"); if (fail) throw fail; return [{ id: "chrome:Default", name: "Person 1", browserName: "Chrome", lastUsed: true }]; },
    sites: async (profileId, caller) => { calls.push(`sites:${profileId}:${caller}`); if (fail) throw fail; return { ticket: "t1", profileName: "Person 1", browserName: "Chrome", sites: [{ site: "example.com", cookies: 2, sensitive: null, suggested: true }] }; },
    run: async (input) => {
      calls.push(`run:${input.ticket}:${input.caller}:${input.sites.join(",")}`);
      if (fail) throw fail;
      await input.write([]);
      return { imported: { sites: input.sites.length, cookies: 2 }, skipped: 0, running: false, sites: [] };
    },
  });
  const gates = { enabled: true, owner: true };
  async function serveImport(fail?: Error, chromeImport: BrowserSitesRouteDeps["chromeImport"] | null = undefined) {
    calls.length = 0; written.length = 0; gates.enabled = true; gates.owner = true;
    const routes = [createBrowserSiteRoutes({
      target: (which) => ("bot" in which && which.bot === "guest-bot" ? { status: 409, error: "A temporary browser saves no sign-ins." } : { binaryPath: "/engine", session: "bot-pepper", env: {}, encryptionKey: "k" }),
      list: async () => ({ running: false, sites: [] }),
      signOut: async () => ({ running: false, sites: [] }),
      ...(chromeImport === null ? {} : { chromeImport: chromeImport ?? {
        enabled: () => gates.enabled, owner: () => gates.owner, caller: () => "loopback", service: spy(fail),
        write: (target) => async (cookies) => { written.push(target.session, cookies); return { running: false, sites: [] }; },
      } }),
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
      try {
        if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
      } catch (error) { json(res, (error as { status?: number }).status ?? 500, { error: "refused" }); }
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, type = "application/json") => fetch(`${base}/api/browser-sites${path}`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { base, post };
  }
  const IMPORT = { bot: "pepper", ticket: "t1", sites: ["example.com"] };

  it("run for the owner, bind the ticket to the caller, and never cache", async () => {
    const { base, post } = await serveImport();
    const profiles = await fetch(`${base}/api/browser-sites/import/profiles`);
    expect(profiles.status).toBe(200);
    expect(profiles.headers.get("cache-control")).toBe("no-store");
    expect(await profiles.json()).toEqual({ profiles: [{ id: "chrome:Default", name: "Person 1", browserName: "Chrome", lastUsed: true }] });
    const listing = await post("/import/sites", { bot: "pepper", source: "chrome:Default" });
    expect(listing.status).toBe(200);
    expect(listing.headers.get("cache-control")).toBe("no-store");
    expect(((await listing.json()) as { ticket: string }).ticket).toBe("t1");
    const result = await post("/import", IMPORT);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ imported: { sites: 1, cookies: 2 }, skipped: 0, running: false, sites: [] });
    expect(calls).toEqual(["profiles", "sites:chrome:Default:loopback", "run:t1:loopback:example.com"]);
    expect(written).toEqual(["bot-pepper", []]);
  });

  it("answers 404 on all three paths when the gate is off or missing, before any other check", async () => {
    for (const setup of [async () => { const served = await serveImport(); gates.enabled = false; return served; }, () => serveImport(undefined, null)]) {
      const { base, post } = await setup();
      const answers = [(await fetch(`${base}/api/browser-sites/import/profiles`)).status, (await post("/import/sites", "not json", "text/plain")).status, (await post("/import", "not json", "text/plain")).status];
      expect(answers).toEqual([404, 404, 404]);
      expect(calls).toEqual([]);
    }
  });

  it("answers 403 to anyone but the owner and never calls the service", async () => {
    const { base, post } = await serveImport();
    gates.owner = false;
    const response = await fetch(`${base}/api/browser-sites/import/profiles`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only this computer's owner can import sign-ins." });
    expect((await post("/import/sites", { bot: "pepper", source: "chrome:Default" })).status).toBe(403);
    expect((await post("/import", IMPORT)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("take JSON only, and refuse a body that names no browser or is too big", async () => {
    const { post } = await serveImport();
    expect((await post("/import/sites", { bot: "pepper", source: "x" }, "text/plain")).status).toBe(415);
    expect((await post("/import", IMPORT, "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await post("/import", { ticket: "t1", sites: ["example.com"] })).status).toBe(400);
    expect((await post("/import", { profile: "a", bot: "b", ticket: "t1", sites: ["example.com"] })).status).toBe(400);
    expect((await post("/import", { ...IMPORT, pad: "x".repeat(17000) })).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("refuse a bad source, ticket or site list with 400", async () => {
    const { post } = await serveImport();
    for (const source of [undefined, 5, "", "x".repeat(257)]) expect((await post("/import/sites", { bot: "pepper", source })).status).toBe(400);
    const bad = [{ ticket: undefined }, { ticket: "" }, { ticket: "t".repeat(257) }, { sites: [] }, { sites: "example.com" }, { sites: [5] }, { sites: ["Example.com"] }, { sites: ["a b"] },
      { sites: Array.from({ length: 501 }, (_, index) => `s${index}.test`) }];
    for (const change of bad) {
      const response = await post("/import", { ...IMPORT, ...change });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Choose sites from the list." });
    }
    expect(calls).toEqual([]);
  });

  it("keep the access rules of the browser target", async () => {
    const { post } = await serveImport();
    const response = await post("/import", { ...IMPORT, bot: "guest-bot" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A temporary browser saves no sign-ins." });
    expect(calls).toEqual([]);
  });

  it("map each ChromeImportError to its status and message", async () => {
    for (const [status, message] of [[409, "This list of sites has expired. Open it again."], [400, "Choose sites from the list."], [413, "This Chrome profile is too large to import."], [503, "Seira could not open Chrome's saved logins."], [404, "That browser profile is no longer available."]] as const) {
      const { base, post } = await serveImport(new ChromeImportError(status, message));
      for (const response of [await post("/import", IMPORT), await post("/import/sites", { bot: "pepper", source: "chrome:Default" }), await fetch(`${base}/api/browser-sites/import/profiles`)]) {
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: message });
      }
    }
  });

  it("never lets the message of another error reach the response", async () => {
    const { base, post } = await serveImport(new Error("EACCES /home/someone/.config/google-chrome/Default/Network/Cookies cookie=SECRET-VALUE"));
    for (const response of [await post("/import", IMPORT), await post("/import/sites", { bot: "pepper", source: "chrome:Default" }), await fetch(`${base}/api/browser-sites/import/profiles`)]) {
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "Seira could not import these sign-ins. Try again." });
      expect(text).not.toContain("SECRET-VALUE");
    }
  });
});
