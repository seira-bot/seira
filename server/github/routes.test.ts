import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GithubAppStatus, GithubBotPolicy } from "../../shared/github-app.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { fakeInstallation, startGithubBrokerFake, type GithubBrokerFake } from "../testing/github-broker-fake.ts";
import { createGithubBrokerClient } from "./broker-client.ts";
import { createGithubRoutes } from "./routes.ts";
import { createGithubStore, type GithubStore } from "./store.ts";

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s1", tokenHash: "a".repeat(64), label: "x", scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: 1, ...over,
});
const people: Record<string, RequestAuth> = {
  desktop: { kind: "loopback", scopes: ["admin", "client"] },
  ana: { kind: "session", session: session({ id: "a", email: "ana@shop.example" }), via: "bearer", scopes: ["admin", "client"] },
  bob: { kind: "session", session: session({ id: "b", email: "bob@shop.example" }), via: "bearer", scopes: ["admin", "client"] },
  editor: { kind: "session", session: session({ id: "e", email: "eve@shop.example", scopes: ["client"], teamRole: "member" }), via: "bearer", scopes: ["client"] },
  viewer: { kind: "session", session: session({ id: "v", scopes: ["client"] }), via: "bearer", scopes: ["client"] },
  service: { kind: "loopback", scopes: ["client"], trust: "service" },
};

const policy = (over: Partial<GithubBotPolicy> = {}): GithubBotPolicy => ({
  repos: [{ installationId: 1, repositoryId: 10, fullName: "shop/site", level: "read" }], askBeforeBigChanges: true, ownBranchesOnly: true, ...over,
});

let fake: GithubBrokerFake;
let dir: string;
let store: GithubStore;
let server: Server;
let base: string;
let enabled = true;
const bots = new Set(["ada", "bo"]);
const hiddenFrom = new Map<RequestAuth, Set<string>>();

beforeEach(async () => {
  fake = await startGithubBrokerFake();
  fake.installations.push(fakeInstallation(1, "shop", [{ id: 10, name: "site" }, { id: 11, name: "docs" }]));
  fake.expectCode("ABCDEFGHJK", [1]);
  dir = mkdtempSync(join(tmpdir(), "seira-gh-routes-"));
  store = createGithubStore(join(dir, "data"));
  enabled = true;
  hiddenFrom.clear();
  const handler = createGithubRoutes({
    cfg: () => ({ features: { githubApp: enabled }, profile: { name: "Rama" } }),
    env: {},
    store,
    broker: createGithubBrokerClient({ access: () => ({ url: fake.url, token: fake.token }) }),
    botExists: (id) => bots.has(id),
    botVisible: (auth, id) => !hiddenFrom.get(auth)?.has(id),
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const auth = people[String(req.headers["x-as"] ?? "desktop")]!;
    const out = await handler({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (typeof out === "symbol" && !res.headersSent) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, as = "desktop", body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-as": as, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: parsed };
}

async function connectAs(as: string) {
  const out = await call("POST", "/api/github-app/complete", as, { code: "abcde-fghjk" });
  expect(out.status).toBe(200);
  return out.body as GithubAppStatus;
}

describe("github routes with the flag off", () => {
  it("answers GET with a disabled status and every other route with 404", async () => {
    enabled = false;
    expect(await call("GET", "/api/github-app")).toEqual({ status: 200, body: { enabled: false, connected: false, canEdit: false, ownedByYou: false, accounts: [], pending: [], bots: {} } });
    for (const [method, path] of [["POST", "/api/github-app/connect"], ["POST", "/api/github-app/complete"], ["POST", "/api/github-app/refresh"], ["PUT", "/api/github-app/bots/ada"], ["DELETE", "/api/github-app/accounts/1"], ["DELETE", "/api/github-app"]] as const) {
      expect((await call(method, path, "desktop", {})).status).toBe(404);
    }
  });

  it("passes other paths on", async () => {
    expect((await call("GET", "/api/other")).status).toBe(418);
  });
});

describe("github routes", () => {
  it("completes with a typed code, stores the account and makes the requester the owner", async () => {
    const status = await connectAs("ana");
    expect(status).toMatchObject({ enabled: true, connected: true, canEdit: true, ownedByYou: true, ownerLabel: "ana" });
    expect(status.accounts[0]!.repositories).toHaveLength(2);
    expect(store.read().ownerKey).toBeTruthy();
    const bob = (await call("GET", "/api/github-app", "bob")).body as GithubAppStatus;
    expect(bob).toMatchObject({ connected: true, canEdit: false, ownedByYou: false, ownerLabel: "ana" });
  });

  it("refuses a bad code with 400 and links nothing", async () => {
    expect((await call("POST", "/api/github-app/complete", "desktop", { code: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/github-app/complete", "desktop", { code: "ZZZZZZZZZZ" })).status).toBe(400);
    expect(store.read().accounts).toEqual([]);
    expect(store.read().ownerKey).toBeUndefined();
  });

  it("answers codeEntry for a remote browser and calls the broker without returnTo", async () => {
    const out = await call("POST", "/api/github-app/connect", "ana", {}, { "x-forwarded-for": "203.0.113.5" });
    expect(out).toMatchObject({ status: 200, body: { codeEntry: true } });
    expect(out.body.url).toMatch(/^https:/);
    expect(fake.connectBodies).toEqual([{}]);
  });

  it("finishes on its own through the loopback return page and sets the owner", async () => {
    const out = await call("POST", "/api/github-app/connect", "desktop");
    expect(out).toMatchObject({ status: 200, body: { codeEntry: false } });
    const returnTo = fake.connectBodies[0]!.returnTo!;
    expect(returnTo).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/github\/return$/);
    const page = await fetch(`${returnTo}?code=ABCDEFGHJK`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("GitHub is connected. You can close this tab and go back to Seira.");
    const status = (await call("GET", "/api/github-app")).body as GithubAppStatus;
    expect(status).toMatchObject({ connected: true, ownedByYou: true, ownerLabel: "Rama" });
    await expect(fetch(`${returnTo}?code=ABCDEFGHJK`)).rejects.toThrow();
  });

  it("shows a failure page for a bad code and then closes", async () => {
    await call("POST", "/api/github-app/connect", "desktop");
    const returnTo = fake.connectBodies[0]!.returnTo!;
    const page = await fetch(`${returnTo}?code=ZZZZZZZZZZ`);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("GitHub was not connected. Go back to Seira and try again.");
    expect(store.read().accounts).toEqual([]);
  });

  it("lets a new connect replace the earlier listener", async () => {
    await call("POST", "/api/github-app/connect", "desktop");
    const first = fake.connectBodies[0]!.returnTo!;
    await call("POST", "/api/github-app/connect", "desktop");
    expect(fake.connectBodies[1]!.returnTo).not.toBe(first);
    await expect(fetch(`${first}?code=ABCDEFGHJK`)).rejects.toThrow();
  });

  it("refuses a connect from a non-owner once someone owns it, and from a service caller", async () => {
    await connectAs("ana");
    expect((await call("POST", "/api/github-app/connect", "bob")).status).toBe(403);
    expect((await call("POST", "/api/github-app/complete", "bob", { code: "ABCDEFGHJK" })).status).toBe(403);
    expect((await call("POST", "/api/github-app/connect", "service")).status).toBe(403);
  });

  it("refuses every change from a non-owner admin, a Team Cloud editor and a viewer (AC-05)", async () => {
    await connectAs("ana");
    const before = JSON.stringify(store.read());
    for (const as of ["bob", "desktop", "editor", "viewer", "service"]) {
      for (const [method, path, body] of [
        ["PUT", "/api/github-app/bots/ada", policy()],
        ["PUT", "/api/github-app/bots/ada", null],
        ["DELETE", "/api/github-app/accounts/1", undefined],
        ["DELETE", "/api/github-app", undefined],
      ] as const) {
        const out = await call(method, path, as, body === undefined ? undefined : body);
        expect(out.status, `${as} ${method} ${path}`).toBe(403);
        expect(out.body.error).toBe("Only ana can change GitHub access.");
      }
    }
    expect(JSON.stringify(store.read())).toBe(before);
  });

  it("lets a viewer read and refresh", async () => {
    await connectAs("ana");
    expect((await call("GET", "/api/github-app", "viewer")).status).toBe(200);
    expect((await call("POST", "/api/github-app/refresh", "viewer")).status).toBe(200);
  });

  it("shows a person who did not connect GitHub only the bots they see and the repositories those bots use", async () => {
    await connectAs("ana");
    await call("PUT", "/api/github-app/bots/ada", "ana", policy({ repos: [{ installationId: 1, repositoryId: 10, fullName: "shop/site", level: "write" }] }));
    await call("PUT", "/api/github-app/bots/bo", "ana", policy({ repos: [{ installationId: 1, repositoryId: 11, fullName: "shop/docs", level: "read" }] }));
    store.update((data) => { data.pending = [{ login: "other-org" }]; });
    hiddenFrom.set(people.editor!, new Set(["bo"]));
    for (const [method, path] of [["GET", "/api/github-app"], ["POST", "/api/github-app/refresh"]] as const) {
      const member = (await call(method, path, "editor")).body as GithubAppStatus;
      expect(Object.keys(member.bots), path).toEqual(["ada"]);
      expect(member.accounts[0]!.repositories.map((repo) => repo.id), path).toEqual([10]);
      expect(member.accounts[0]!.repositoryCount, path).toBe(2);
      expect(JSON.stringify(member), path).not.toContain("shop/docs");
      expect(member.pending, path).toEqual([]);
    }
    const owner = (await call("GET", "/api/github-app", "ana")).body as GithubAppStatus;
    expect(Object.keys(owner.bots).sort()).toEqual(["ada", "bo"]);
    expect(owner.accounts[0]!.repositories).toHaveLength(2);
    expect(owner.accounts[0]!.repositoryCount).toBeUndefined();
  });

  it("hides a bot from its owner's status and refuses its change when the owner cannot see it", async () => {
    await connectAs("ana");
    await call("PUT", "/api/github-app/bots/bo", "ana", policy());
    hiddenFrom.set(people.ana!, new Set(["bo"]));
    expect((await call("GET", "/api/github-app", "ana")).body.bots).toEqual({});
    expect((await call("PUT", "/api/github-app/bots/bo", "ana", policy({ repos: [] }))).status).toBe(404);
    expect((await call("PUT", "/api/github-app/bots/bo", "ana", null)).status).toBe(404);
    expect(store.read().bots.bo).toEqual(policy());
  });

  it("stores a bot policy as the owner sent it, and leaves out bots that no longer exist", async () => {
    await connectAs("ana");
    const set = await call("PUT", "/api/github-app/bots/ada", "ana", policy());
    expect(set.status).toBe(200);
    expect(set.body.bots.ada.repos).toEqual([{ installationId: 1, repositoryId: 10, fullName: "shop/site", level: "read" }]);
    expect((await call("PUT", "/api/github-app/bots/ada", "ana", { ...policy(), repos: [] })).body.bots.ada.repos).toEqual([]);
    bots.delete("bo");
    store.update((data) => { data.bots.bo = policy(); });
    expect(Object.keys((await call("GET", "/api/github-app", "ana")).body.bots)).toEqual(["ada"]);
    bots.add("bo");
  });

  it("gives a new bot an empty list and removes a bot with null", async () => {
    await connectAs("ana");
    const empty = await call("PUT", "/api/github-app/bots/ada", "ana", { repos: [], askBeforeBigChanges: true, ownBranchesOnly: true });
    expect(empty.body.bots.ada.repos).toEqual([]);
    expect((await call("PUT", "/api/github-app/bots/ada", "ana", null)).body.bots).toEqual({});
  });

  it("rejects an unknown bot, a repository that is not connected and a bad body", async () => {
    await connectAs("ana");
    expect((await call("PUT", "/api/github-app/bots/ghost", "ana", policy())).status).toBe(404);
    const other = policy({ repos: [{ installationId: 1, repositoryId: 99, fullName: "x/y", level: "read" }] });
    expect((await call("PUT", "/api/github-app/bots/ada", "ana", other)).status).toBe(400);
    expect((await call("PUT", "/api/github-app/bots/ada", "ana", { repos: "no" })).status).toBe(400);
    expect((await call("PUT", "/api/github-app/bots/ada", "ana", { ...policy(), extra: 1 })).status).toBe(400);
    expect(store.read().bots).toEqual({});
  });

  it("removes the grants of a disconnected account from every bot (AC-16)", async () => {
    await connectAs("ana");
    await call("PUT", "/api/github-app/bots/ada", "ana", policy());
    await call("PUT", "/api/github-app/bots/bo", "ana", policy({ repos: [{ installationId: 1, repositoryId: 11, fullName: "shop/docs", level: "write" }] }));
    const out = await call("DELETE", "/api/github-app/accounts/1", "ana");
    expect(out.status).toBe(200);
    expect(out.body.manageUrl).toBe("https://github.com/settings/installations");
    expect(out.body.status).toMatchObject({ connected: false, accounts: [], bots: { ada: { repos: [] }, bo: { repos: [] } } });
    expect(fake.unlinked).toEqual([1]);
    expect(store.read().ownerKey).toBeUndefined();
  });

  it("drops a repository grant when the repository leaves the installation on refresh", async () => {
    await connectAs("ana");
    await call("PUT", "/api/github-app/bots/ada", "ana", policy({ repos: [
      { installationId: 1, repositoryId: 10, fullName: "shop/site", level: "read" },
      { installationId: 1, repositoryId: 11, fullName: "shop/docs", level: "read" },
    ] }));
    fake.installations[0]!.repositories = fake.installations[0]!.repositories.filter((repo) => repo.id !== 11);
    const out = await call("POST", "/api/github-app/refresh", "viewer");
    expect(out.body.bots.ada.repos.map((repo: { repositoryId: number }) => repo.repositoryId)).toEqual([10]);
  });

  it("clears the owner when refresh finds nothing left", async () => {
    await connectAs("ana");
    fake.installations = [];
    const out = await call("POST", "/api/github-app/refresh", "ana");
    expect(out.body).toMatchObject({ connected: false, canEdit: true });
    expect(store.read().ownerKey).toBeUndefined();
  });

  it("disconnects everything with DELETE and clears the owner", async () => {
    await connectAs("ana");
    await call("PUT", "/api/github-app/bots/ada", "ana", policy());
    const out = await call("DELETE", "/api/github-app", "ana");
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ connected: false, accounts: [], bots: {} });
    expect(store.read()).toEqual({ version: 1, accounts: [], pending: [], bots: {} });
    expect(fake.unlinked).toEqual([1]);
  });

  it("answers a short error when the broker fails and changes nothing", async () => {
    fake.failNext("installations", 502);
    const out = await call("POST", "/api/github-app/refresh", "desktop");
    expect(out.status).toBe(502);
    expect(out.body.error).toBe("GitHub is not reachable right now.");
  });
});
