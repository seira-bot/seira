// The joining side's route guard against the fake relay: a paired reference phone stands in for the far server, and a
// dial spy records the order in which relay nodes are tried.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { b64u, ed25519RawPublicKey, fromB64u, mintRelayToken } from "../../companion/src/e2e/credentials.ts";
import { parseDescriptor } from "../../companion/src/e2e/descriptor.ts";
import { NoiseError } from "../../companion/src/e2e/noise.ts";
import { dial as realDial, type dial } from "../../companion/src/e2e/phone.ts";
import { SessionClosed, type E2ESession } from "../../companion/src/e2e/session.ts";
import { startFakeRelay, type FakeRelay } from "../../companion/test/e2e/fake-relay.ts";
import { http, json, waitFor } from "../../companion/test/e2e/rig.ts";
import { startPhoneRelay, type PhoneRelay } from "../phone-relay.ts";
import { SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createRelayLinkFetch, openRelaySession, placeholderOrigin, type RelayRoute } from "./linked-servers-relay.ts";

const signingKey = generateKeyPairSync("ed25519").privateKey;
const keys = new Map([["k1", ed25519RawPublicKey(signingKey)]]);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Far {
  relay: FakeRelay;
  sessions: SessionRegistry;
  phoneRelay: PhoneRelay;
  route: RelayRoute;
  /** A credential the far server admits, as a link's token would be. */
  token: string;
  tokenId: string;
  seen: string[];
}

async function far(): Promise<Far> {
  const dir = mkdtempSync(join(tmpdir(), "seira-link-route-"));
  cleanup.push(() => removeTempDir(dir));
  const relay = await startFakeRelay({ keys });
  cleanup.push(() => relay.close());
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  cleanup.push(() => sessions.close());
  const hostId = randomBytes(16);
  const iat = Math.floor(Date.now() / 1000);
  const grant = { token: mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: "test-install", iat, exp: iat + 43_200 }, signingKey), hostId: b64u(hostId), nodes: ["relay1.seira.bot"], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000 };
  const seen: string[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://server");
    seen.push(`${req.method} ${url.pathname}`);
    const send = (status: number, payload: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (req.method === "POST" && url.pathname === "/api/pair") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const paired = sessions.exchange({ code: (JSON.parse(raw) as { credential: string }).credential, label: "Pixel", source: "test" });
      return paired.ok ? send(200, { token: paired.token, device: { id: paired.session.id } }) : send(paired.status, { error: paired.error });
    }
    return send(200, { path: url.pathname });
  };
  let phoneRelay: PhoneRelay | null = null;
  phoneRelay = startPhoneRelay({
    env: { SEIRA_PHONE_RELAY: "1", SEIRA_PHONE_RELAY_URL: relay.url },
    dataDir: dir,
    sessions,
    handle: (req, res) => void handle(req, res),
    serverName: () => "VPS",
    publicOrigin: () => null,
    version: "0.1.152",
    refusal: null,
    fetchGrant: async () => grant,
    log: () => {},
  });
  if (!phoneRelay) throw new Error("the relay did not start");
  const started = phoneRelay;
  cleanup.push(() => started.stop());
  await waitFor(() => started.status().relay === "connected", 5_000);

  const pair = sessions.openPairing({ scopes: ["client"] });
  const descriptor = JSON.parse(fromB64u(new URL(started.invite(pair.credential, "VPS", null)!).searchParams.get("e2e")!)!.toString("utf8"));
  const parsed = parseDescriptor(descriptor);
  if (parsed.outcome !== "ok" || !parsed.hostId) throw new Error("no relay descriptor");
  const route: RelayRoute = { e2e: parsed.descriptor, transportKey: parsed.transportKey, hostId: parsed.hostId };
  // The paired phone's token is what a joined link holds: the far server admits it.
  const paired = await waitFor(() => openRelaySession(route, pair.credential, { app: "test/1", baseUrl: relay.url }).catch(() => null), 6_000);
  const reply = json(await http(paired, "POST", "/api/pair", { body: JSON.stringify({ credential: pair.credential }), headers: { "content-type": "application/json" } })) as { token: string; device: { id: string } };
  paired.shutdown();
  seen.length = 0;
  return { relay, sessions, phoneRelay: started, route, token: reply.token, tokenId: reply.device.id, seen };
}

const placeholder = (route: RelayRoute) => placeholderOrigin(route.hostId);
const nodeRoute = (route: RelayRoute, nodes: string[]): RelayRoute => ({ ...route, e2e: { ...route.e2e, r: nodes } });

describe("openRelaySession", () => {
  it("tries the relay nodes in the order the route names them, and stops at the first that answers", async () => {
    const route = nodeRoute((await far()).route, ["relay2.seira.bot", "relay1.seira.bot", "relay3.seira.bot"]);
    const urls: string[] = [];
    const session = { shutdown() {} } as unknown as E2ESession<never>;
    const fake = vi.fn(async (options: Parameters<typeof dial>[0]) => {
      urls.push(options.url);
      if (urls.length === 1) throw new SessionClosed(4404);
      return session;
    });
    await expect(openRelaySession(route, "secret", { app: "test/1", dial: fake as typeof dial })).resolves.toBe(session);
    expect(urls).toEqual(["wss://relay2.seira.bot/v1/phone", "wss://relay1.seira.bot/v1/phone"]);
  });

  it("rejects with 4404 only when every node answered 4404, and stops at a pin mismatch or a rejected handshake", async () => {
    const route = nodeRoute((await far()).route, ["relay1.seira.bot", "relay2.seira.bot"]);
    const calls: string[] = [];
    const answering = (errors: unknown[]) => vi.fn(async (options: Parameters<typeof dial>[0]) => {
      calls.push(options.url);
      throw errors[calls.length - 1];
    }) as unknown as typeof dial;
    await expect(openRelaySession(route, "secret", { app: "t", dial: answering([new SessionClosed(4404), new SessionClosed(4404)]) })).rejects.toEqual(new SessionClosed(4404));
    expect(calls).toHaveLength(2);
    calls.length = 0;
    await expect(openRelaySession(route, "secret", { app: "t", dial: answering([new SessionClosed(4404), new SessionClosed(4503)]) })).rejects.toEqual(new SessionClosed(4503));
    calls.length = 0;
    await expect(openRelaySession(route, "secret", { app: "t", dial: answering([new NoiseError("pin"), new SessionClosed(4404)]) })).rejects.toBeInstanceOf(NoiseError);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    await expect(openRelaySession(route, "secret", { app: "t", dial: answering([new SessionClosed(4001), new SessionClosed(4404)]) })).rejects.toEqual(new SessionClosed(4001));
    expect(calls).toHaveLength(1);
  });
});

describe("createRelayLinkFetch", () => {
  it("dials on the first call, reuses its one session, and never touches the placeholder origin (AC-19)", async () => {
    const f = await far();
    const global = vi.spyOn(globalThis, "fetch");
    cleanup.push(() => global.mockRestore());
    const removed = vi.fn();
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", baseUrl: f.relay.url, removed });
    cleanup.push(() => link.close());
    expect(link.online()).toBe(false);
    const answers = await Promise.all([1, 2, 3].map((n) => link.fetch(`${placeholder(f.route)}/link/exchange?n=${n}`).then((a) => a.json())));
    expect(answers).toEqual([{ path: "/link/exchange" }, { path: "/link/exchange" }, { path: "/link/exchange" }]);
    expect(link.online()).toBe(true);
    expect(global).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    // The three parallel calls shared one dial: the relay spliced one session.
    expect([...f.relay.hosts.values()][0]!.sessions.size).toBe(1);
  });

  it("dials again after the relay dropped its session, and the next call works (AC-08)", async () => {
    const f = await far();
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", baseUrl: f.relay.url, removed: vi.fn() });
    cleanup.push(() => link.close());
    expect((await link.fetch(`${placeholder(f.route)}/a`)).status).toBe(200);
    expect(link.online()).toBe(true);
    f.relay.forgeClose(4503);
    await waitFor(() => (link.online() ? null : true), 5_000);
    const again = await waitFor(() => link.fetch(`${placeholder(f.route)}/b`).then((a) => a.json(), () => null), 8_000);
    expect(again).toEqual({ path: "/b" });
    expect(link.online()).toBe(true);
  });

  it("shares one dial between calls that arrive while it is in progress", async () => {
    const f = await far();
    let release: (session: E2ESession<never>) => void = () => {};
    const dials: string[] = [];
    const slow = vi.fn((options: Parameters<typeof dial>[0]) => {
      dials.push(options.url);
      return new Promise<E2ESession<never>>((resolve) => { release = resolve; });
    }) as unknown as typeof dial;
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", removed: vi.fn(), dial: slow });
    cleanup.push(() => link.close());
    const calls = [1, 2, 3].map((n) => link.fetch(`${placeholder(f.route)}/n${n}`).then((a) => a.status, (error: unknown) => error));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dials).toHaveLength(1);
    const real = await openRelaySession(f.route, f.token, { app: "test/1", baseUrl: f.relay.url });
    release(real);
    expect(await Promise.all(calls)).toEqual([200, 200, 200]);
    expect(dials).toHaveLength(1);
  });

  it("answers an abort that comes while the dial is still in progress, and leaves the dial for the others", async () => {
    const f = await far();
    const never = vi.fn(() => new Promise<E2ESession<never>>(() => {})) as unknown as typeof dial;
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", removed: vi.fn(), dial: never });
    const controller = new AbortController();
    const pending = link.fetch(`${placeholder(f.route)}/a`, { signal: controller.signal });
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(never).toHaveBeenCalledTimes(1);
  });

  it("tries the second node when the first one does not know this server, and the link stays", async () => {
    const f = await far();
    const removed = vi.fn();
    const urls: string[] = [];
    const first = ((options: Parameters<typeof dial>[0]) => {
      urls.push(options.url);
      return urls.length === 1 ? Promise.reject(new SessionClosed(4404)) : realDial({ ...options, url: `${f.relay.url}/v1/phone` });
    }) as typeof dial;
    const link = createRelayLinkFetch(nodeRoute(f.route, ["relay2.seira.bot", "relay1.seira.bot"]), () => f.token, { app: "test/1", removed, refusedForMs: 0, dial: first });
    cleanup.push(() => link.close());
    expect((await link.fetch(`${placeholder(f.route)}/a`)).status).toBe(200);
    expect(urls).toEqual(["wss://relay2.seira.bot/v1/phone", "wss://relay1.seira.bot/v1/phone"]);
    expect(removed).not.toHaveBeenCalled();
  });

  it("calls removed() once when every node answers 4404 for as long as the caller waits, then rejects without a dial (AC-08)", async () => {
    const f = await far();
    const removed = vi.fn();
    const dials = vi.fn((_options: Parameters<typeof dial>[0]) => Promise.reject(new SessionClosed(4404)));
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", removed, refusedForMs: 0, dial: dials as unknown as typeof dial });
    cleanup.push(() => link.close());
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toEqual(new SessionClosed(4404));
    expect(removed).toHaveBeenCalledTimes(1);
    expect(dials).toHaveBeenCalledTimes(1);
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toThrow(/removed this link/);
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toThrow(/removed this link/);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(dials).toHaveBeenCalledTimes(1);
  });

  it("does not call removed() on 4404 by default, so a far server that is off can come back", async () => {
    const f = await far();
    const removed = vi.fn();
    const dials = vi.fn((_options: Parameters<typeof dial>[0]) => Promise.reject(new SessionClosed(4404)));
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", removed, dial: dials as unknown as typeof dial });
    cleanup.push(() => link.close());
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toEqual(new SessionClosed(4404));
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toEqual(new SessionClosed(4404));
    expect(removed).not.toHaveBeenCalled();
    expect(dials).toHaveBeenCalledTimes(2);
  });

  it("calls removed() once when the far server removes the link inside the session, and dials no more", async () => {
    const f = await far();
    const removed = vi.fn();
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", baseUrl: f.relay.url, removed });
    cleanup.push(() => link.close());
    expect((await link.fetch(`${placeholder(f.route)}/a`)).status).toBe(200);
    expect(f.sessions.revoke(f.tokenId)).toBe(true);
    await waitFor(() => (removed.mock.calls.length ? true : null), 5_000);
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toThrow(/removed this link/);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(link.online()).toBe(false);
  });

  it("is not admitted with a credential the far server does not know, and that alone never removes the link", async () => {
    const f = await far();
    const removed = vi.fn();
    const link = createRelayLinkFetch(f.route, () => `lsk_${randomBytes(32).toString("base64url")}`, { app: "test/1", baseUrl: f.relay.url, removed });
    cleanup.push(() => link.close());
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toEqual(new SessionClosed(4404));
    expect(removed).not.toHaveBeenCalled();
    expect(f.seen).toEqual([]);
  });

  it("rejects without a dial when there is no credential", async () => {
    const f = await far();
    const dials = vi.fn();
    const link = createRelayLinkFetch(f.route, () => null, { app: "test/1", removed: vi.fn(), dial: dials as unknown as typeof dial });
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toThrow(/no credential/);
    expect(dials).not.toHaveBeenCalled();
  });

  it("closes its session on close() and rejects later calls without a dial", async () => {
    const f = await far();
    const removed = vi.fn();
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", baseUrl: f.relay.url, removed });
    expect((await link.fetch(`${placeholder(f.route)}/a`)).status).toBe(200);
    link.close();
    expect(link.online()).toBe(false);
    await expect(link.fetch(`${placeholder(f.route)}/a`)).rejects.toThrow(/closed/);
    await waitFor(() => (f.relay.hosts.values().next().value?.sessions.size === 0 ? true : null), 5_000);
    expect(removed).not.toHaveBeenCalled();
    link.close();
  });

  it("closes a session that finishes dialing after close()", async () => {
    const f = await far();
    let release: (session: E2ESession<never>) => void = () => {};
    const slow = (() => new Promise<E2ESession<never>>((resolve) => { release = resolve; })) as unknown as typeof dial;
    const link = createRelayLinkFetch(f.route, () => f.token, { app: "test/1", removed: vi.fn(), dial: slow });
    const call = link.fetch(`${placeholder(f.route)}/a`).catch((error: unknown) => error);
    link.close();
    const real = await openRelaySession(f.route, f.token, { app: "test/1", baseUrl: f.relay.url });
    release(real);
    expect(await call).toBeInstanceOf(Error);
    await real.closed;
    expect(real.state).toBe("closed");
    expect(link.online()).toBe(false);
  });
});

