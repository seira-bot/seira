// A real server with a tunnel address, a tailnet address and an own domain gives a phone every route in its link, and
// a paired phone can ask for the routes again. A stranger who came through a proxy learns nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-seira.ts";

const TUNNEL = `https://c-${"a".repeat(32)}.seira.run`;
const TAILNET = "https://box.tail1234.ts.net";
let fixture: VerificationServer;
let url: string;

const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(url + path, { ...init, headers: { "content-type": "application/json", origin: url, ...init.headers }, signal: AbortSignal.timeout(30_000) });
  return { status: response.status, text: await response.text() };
};
const endpointsOf = (link: string) => JSON.parse(Buffer.from(/[#&]endpoints=([^&]+)/.exec(link)![1]!, "base64url").toString("utf8")) as Array<{ url: string; kind: string; priority: number }>;

beforeAll(async () => {
  fixture = await launchVerificationServer({ SEIRA_PUBLIC_URL: TUNNEL, SEIRA_PHONE_ROUTES: TAILNET });
  url = fixture.info.url;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

describe("phone routes", () => {
  it("puts every route in the code link and the token link, with the tunnel first to open", async () => {
    const minted = await call("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["client"] }) });
    expect(minted.status).toBe(200);
    const body = JSON.parse(minted.text) as { code: string; url: string; inviteUrl: string };
    expect(body.url.startsWith(`${TUNNEL}/pair#code=${body.code}&endpoints=`)).toBe(true);
    const expected = [{ url: TAILNET, kind: "hosted", priority: 0 }, { url: TUNNEL, kind: "hosted", priority: 1 }];
    expect(endpointsOf(body.url)).toEqual(expected);
    const invite = new URL(body.inviteUrl);
    expect(invite.searchParams.get("address")).toBe(TUNNEL);
    expect(JSON.parse(Buffer.from(invite.searchParams.get("endpoints")!, "base64url").toString("utf8"))).toEqual(expected);
  }, 60_000);

  it("answers a paired phone with the routes and refuses a caller who has not paired", async () => {
    const minted = JSON.parse((await call("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["client"] }) })).text) as { code: string };
    const paired = JSON.parse((await call("/api/auth/pair", { method: "POST", body: JSON.stringify({ code: minted.code }) })).text) as { token: string };
    const answer = await call("/api/companion/endpoints", { headers: { authorization: `Bearer ${paired.token}` } });
    expect(answer.status).toBe(200);
    const snapshot = JSON.parse(answer.text) as { serverName: string; endpoints: unknown[]; version: string };
    expect(snapshot.endpoints).toEqual([{ url: TAILNET, kind: "hosted", priority: 0 }, { url: TUNNEL, kind: "hosted", priority: 1 }]);
    expect(snapshot.serverName).toBeTruthy();
    expect(snapshot.version).toBeTruthy();

    const stranger = await call("/api/companion/endpoints", { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(stranger.status).toBe(403);
    expect(stranger.text).not.toContain(snapshot.serverName);
    expect(stranger.text).not.toContain(snapshot.version);
    expect(stranger.text).not.toContain(TAILNET);
  }, 60_000);

  it("shows an unpaired caller from a proxy no bot, account or route data", async () => {
    for (const headers of [{ "x-forwarded-for": "203.0.113.9" }, { "cf-connecting-ip": "203.0.113.9" }]) {
      for (const path of ["/api/bots", "/api/config", "/api/auth/session", "/api/auth/pairing", "/api/companion/endpoints"]) {
        const answer = await call(path, { headers });
        expect(answer.status, path).toBe(403);
        expect(answer.text, path).not.toMatch(/tail1234|seira\.run|"bots"|"serverName"|"version"/u);
      }
      const health = await call("/api/health", { headers });
      expect(["app", "legacyApp"]).toEqual(expect.arrayContaining(Object.keys(JSON.parse(health.text))));
    }
  }, 60_000);
});
