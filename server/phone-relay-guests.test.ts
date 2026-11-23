// The guest seam of the phone relay against the fake relay: links of other servers and their invites share the relay
// identity with phones, and reach only the routes that are theirs.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { admission, admissionHash, b64u, credentialHash, ed25519RawPublicKey, fromB64u, keyId, mintRelayToken, psk } from "../companion/src/e2e/credentials.ts";
import { TRANSPORT_RELAY } from "../companion/src/e2e/noise.ts";
import { dial } from "../companion/src/e2e/phone.ts";
import { SessionClosed, type E2ESession } from "../companion/src/e2e/session.ts";
import { startFakeRelay, type FakeRelay } from "../companion/test/e2e/fake-relay.ts";
import { http, json, waitFor } from "../companion/test/e2e/rig.ts";
import { LINK_DEVICE_PREFIX, type LinkRelayGuests, type LinkRelayHost } from "./host/linked-servers-relay.ts";
import { MAX_RELAY_PHONES, PHONE_RELAY_PHONES_FILE, startPhoneRelay, type PhoneRelay } from "./phone-relay.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const signingKey = generateKeyPairSync("ed25519").privateKey;
const keys = new Map([["k1", ed25519RawPublicKey(signingKey)]]);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const asJson = { "content-type": "application/json" };
const EXCHANGE = "/api/link/exchange";
const ACCEPT = "/api/link/accept";

interface Guest { id: string; token: string }

/** The link manager's side: links and invites it holds, the routes it allows, and what the phone relay asked of it. */
class FakeGuests implements LinkRelayGuests {
  links: Guest[] = [];
  invites: string[] = [];
  host: LinkRelayHost | null = null;
  attached: Array<LinkRelayHost | null> = [];
  asked: string[] = [];
  attach(host: LinkRelayHost | null) { this.host = host; this.attached.push(host); }
  records() { return this.links.map((link) => ({ id: link.id, tokenHash: sha256Hex(link.token) })); }
  windows() { return this.invites.map((code) => ({ tokenHash: sha256Hex(code) })); }
  allows(kind: "link" | "invite", method: string, path: string) {
    this.asked.push(`${kind} ${method} ${path}`);
    return kind === "link" ? method === "POST" && path === EXCHANGE : method === "POST" && path === ACCEPT;
  }
  addLink(): Guest {
    const link = { id: randomBytes(8).toString("hex"), token: secret("lsk_") };
    this.links.push(link);
    return link;
  }
  addInvite(): string {
    const code = secret("seira_invite_");
    this.invites.push(code);
    return code;
  }
}

interface Seen { method: string; path: string; level: string | undefined; other: string | undefined; cookie: string | undefined; host: string | undefined; auth: string | undefined }

interface Server {
  dir: string;
  relay: FakeRelay;
  sessions: SessionRegistry;
  phoneRelay: PhoneRelay;
  guests: FakeGuests;
  hostId: Buffer;
  seen: Seen[];
}

async function startServer(input: { dir?: string; guests?: FakeGuests; relay?: FakeRelay; streamDeadlines?: { headersMs: number; requestMs: number } } = {}): Promise<Server> {
  const dir = input.dir ?? mkdtempSync(join(tmpdir(), "seira-phone-relay-guests-"));
  if (!input.dir) cleanup.push(() => removeTempDir(dir));
  const relay = input.relay ?? await startFakeRelay({ keys });
  if (!input.relay) cleanup.push(() => relay.close());
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  cleanup.push(() => sessions.close());
  const guests = input.guests ?? new FakeGuests();
  const hostId = randomBytes(16);
  const iat = Math.floor(Date.now() / 1000);
  const grant = { token: mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: "test-install", iat, exp: iat + 43_200 }, signingKey), hostId: b64u(hostId), nodes: ["relay1.seira.bot"], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000 };
  const seen: Seen[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://server");
    const send = (status: number, payload: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    const header = (name: string) => (typeof req.headers[name] === "string" ? req.headers[name] : undefined);
    seen.push({ method: req.method ?? "", path: url.pathname, level: header("x-seira-bot-link"), other: header("x-seira-other"), cookie: header("cookie"), host: header("host"), auth: header("authorization") });
    if (req.method === "POST" && url.pathname === "/api/pair") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const paired = sessions.exchange({ code: (JSON.parse(raw) as { credential: string }).credential, label: "Pixel", source: "test" });
      return paired.ok ? send(200, { token: paired.token, device: { id: paired.session.id } }) : send(paired.status, { error: paired.error });
    }
    for await (const chunk of req) void chunk;
    if (url.pathname === EXCHANGE) return header("authorization")?.startsWith("Bearer lsk_") ? send(200, { exchanged: true, level: header("x-seira-bot-link") ?? null }) : send(401, { error: "sign in" });
    if (url.pathname === ACCEPT) return send(200, { accepted: true });
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
    guests,
    ...(input.streamDeadlines ? { streamDeadlines: input.streamDeadlines } : {}),
    log: () => {},
  });
  if (!phoneRelay) throw new Error("the relay did not start");
  const started = phoneRelay;
  cleanup.push(() => started.stop());
  await waitFor(() => started.status().relay === "connected", 5_000);
  return { dir, relay, sessions, phoneRelay: started, guests, hostId, seen };
}

const adm = (server: Server, credential: string) => admissionHash(admission(credentialHash(credential), server.hostId));
const transportKey = (server: Server) => fromB64u(server.guests.host!.descriptor()!.k)!;

function viaRelay(server: Server, credential: string): Promise<E2ESession<never>> {
  const k = transportKey(server);
  return dial({
    url: `${server.relay.url}/v1/phone`,
    transportByte: TRANSPORT_RELAY,
    remoteStatic: k,
    psk: psk(credentialHash(credential), keyId(k)),
    app: "test/1",
    relay: { hostId: server.hostId, adm: admission(credentialHash(credential), server.hostId) },
  });
}

const open = (server: Server, credential: string) => waitFor(() => viaRelay(server, credential).catch(() => null), 6_000);

async function pairPhone(server: Server): Promise<{ token: string; id: string; session: E2ESession<never> }> {
  const opened = server.sessions.openPairing({ scopes: ["client"] });
  server.phoneRelay.invite(opened.credential, "VPS", null);
  const session = await open(server, opened.credential);
  const paired = await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: opened.credential }), headers: asJson });
  if (paired.status !== 200) throw new Error(`pairing failed: ${paired.status}`);
  const reply = json(paired) as { token: string; device: { id: string } };
  return { token: reply.token, id: reply.device.id, session };
}

const admitted = (server: Server) => server.relay.admitted(b64u(server.hostId));

describe("guests of the phone relay", () => {
  it("hands the manager the relay host when it starts, and takes it back when it stops", async () => {
    const server = await startServer();
    expect(server.guests.attached).toHaveLength(1);
    const host = server.guests.host!;
    expect(host.descriptor()).toMatchObject({ v: 1, h: b64u(server.hostId), r: ["relay1.seira.bot"] });
    expect(host.room()).toEqual({ devices: 0, links: 0 });
    server.guests.addLink();
    await pairPhone(server);
    expect(host.room()).toEqual({ devices: 1, links: 1 });
    server.phoneRelay.stop();
    expect(server.guests.attached.at(-1)).toBeNull();
    expect(server.guests.host).toBeNull();
  });

  it("admits a link and a live invite at the relay, and drops them when the manager says so", async () => {
    const server = await startServer();
    const link = server.guests.addLink();
    const code = server.guests.addInvite();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, link.token)) && admitted(server).has(adm(server, code)));
    server.guests.links = [];
    server.guests.invites = [];
    server.guests.host!.changed();
    await waitFor(() => !admitted(server).has(adm(server, link.token)) && !admitted(server).has(adm(server, code)));
    await expect(viaRelay(server, link.token)).rejects.toEqual(new SessionClosed(4404));
  });

  it("lets a link peer reach only the routes of a link, and every other path answers as an unknown path does (AC-11)", async () => {
    const server = await startServer();
    const link = server.guests.addLink();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, link.token)));
    const session = await open(server, link.token);
    server.seen.length = 0;
    const ok = await http(session, "POST", EXCHANGE, { token: link.token, body: "{}", headers: asJson });
    expect([ok.status, json(ok)]).toEqual([200, { exchanged: true, level: null }]);
    expect(server.seen).toHaveLength(1);
    server.seen.length = 0;
    const refused: Array<[string, string]> = [["GET", EXCHANGE], ["POST", "/api/pair"], ["POST", "/api/auth/pair"], ["GET", "/api/health"], ["GET", "/api/companion/endpoints"], ["GET", "/api/auth/session"], ["POST", "/api/admin/anything"], ["GET", "/api/events"], ["POST", ACCEPT]];
    for (const [method, path] of refused) {
      const answer = await http(session, method, path, { token: link.token, ...(method === "POST" ? { body: "{}", headers: asJson } : {}) });
      expect([method, path, answer.status, json(answer)]).toEqual([method, path, 404, { error: "not found" }]);
    }
    expect(server.seen).toEqual([]);
  });

  it("answers 401 to a link peer whose bearer is not its own link credential (AC-12)", async () => {
    const server = await startServer();
    const link = server.guests.addLink();
    const other = server.guests.addLink();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, link.token)));
    const phone = await pairPhone(server);
    const session = await open(server, link.token);
    server.seen.length = 0;
    for (const token of [other.token, phone.token, secret("lsk_")]) {
      const answer = await http(session, "POST", EXCHANGE, { token, body: "{}", headers: asJson });
      expect([answer.status, json(answer).error]).toEqual([401, "this connection belongs to another device"]);
    }
    expect(server.seen).toEqual([]);
    expect((await http(session, "POST", EXCHANGE, { token: link.token, body: "{}", headers: asJson })).status).toBe(200);
    // A phone's session never speaks with a link's credential either.
    const swap = await http(phone.session, "POST", EXCHANGE, { token: link.token, body: "{}", headers: asJson });
    expect([swap.status, json(swap).error]).toEqual([401, "this connection belongs to another device"]);
  });

  it("lets an invite peer reach only the request that accepts an invite (AC-13)", async () => {
    const server = await startServer();
    const code = server.guests.addInvite();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, code)));
    const session = await open(server, code);
    server.seen.length = 0;
    const accepted = await http(session, "POST", ACCEPT, { body: "{}", headers: asJson });
    expect([accepted.status, json(accepted)]).toEqual([200, { accepted: true }]);
    expect(server.seen).toHaveLength(1);
    server.seen.length = 0;
    const refused: Array<[string, string]> = [["GET", ACCEPT], ["POST", EXCHANGE], ["POST", "/api/pair"], ["GET", "/api/health"], ["GET", "/api/auth/session"]];
    for (const [method, path] of refused) {
      const answer = await http(session, method, path, method === "POST" ? { body: "{}", headers: asJson } : {});
      expect([method, path, answer.status, json(answer)]).toEqual([method, path, 404, { error: "not found" }]);
    }
    expect(server.seen).toEqual([]);
  });

  it("keeps the phone's routes as they were: a phone peer is never judged as a link, and an unrelated pairing peer still only pairs", async () => {
    const server = await startServer();
    const phone = await pairPhone(server);
    const before = server.guests.asked.length;
    const health = await http(phone.session, "GET", "/api/health", { token: phone.token });
    expect(health.status).toBe(200);
    expect(json(await http(phone.session, "GET", "/api/companion/endpoints", { token: phone.token })).serverName).toBe("VPS");
    const exchange = await http(phone.session, "POST", EXCHANGE, { token: phone.token, body: "{}", headers: asJson });
    expect([exchange.status, json(exchange).error]).toEqual([401, "sign in"]);
    expect(server.guests.asked.length).toBe(before);
    const opened = server.sessions.openPairing({ scopes: ["client"] });
    server.phoneRelay.invite(opened.credential, "VPS", null);
    const pairing = await open(server, opened.credential);
    expect(json(await http(pairing, "GET", "/api/auth/session")).error).toBe("pair this phone first");
    expect(server.guests.asked.length).toBe(before);
  });

  it("keeps the protocol level header for a link peer and removes it, with every other x-seira header, for a phone peer (AC-07)", async () => {
    const server = await startServer();
    const link = server.guests.addLink();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, link.token)));
    const phone = await pairPhone(server);
    const session = await open(server, link.token);
    server.seen.length = 0;
    const headers = { ...asJson, "x-seira-bot-link": "2", "x-seira-other": "x", cookie: "seira_session=x", host: "127.0.0.1:8799" };
    const viaLink = await http(session, "POST", EXCHANGE, { token: link.token, body: "{}", headers });
    expect(json(viaLink)).toEqual({ exchanged: true, level: "2" });
    expect(server.seen[0]).toMatchObject({ level: "2", other: undefined, cookie: undefined, host: "phone-relay.invalid" });
    await http(phone.session, "POST", EXCHANGE, { token: phone.token, body: "{}", headers });
    expect(server.seen[1]).toMatchObject({ level: undefined, other: undefined, cookie: undefined, host: "phone-relay.invalid" });
  });

  it("holds at most two sessions for one link, and refuses the third (AC-16)", async () => {
    const server = await startServer();
    const link = server.guests.addLink();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, link.token)));
    const first = await open(server, link.token);
    const second = await open(server, link.token);
    const third = await open(server, link.token);
    await third.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([first.state, second.state, third.state]).toEqual(["open", "open", "closed"]);
    expect((await http(second, "POST", EXCHANGE, { token: link.token, body: "{}", headers: asJson })).status).toBe(200);
    first.shutdown();
    await first.closed;
    const again = await open(server, link.token);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(again.state).toBe("open");
  });

  it("closes a link's sessions with the removed notice, and the relay admits it no more (AC-18)", async () => {
    const server = await startServer();
    const link = server.guests.addLink();
    const kept = server.guests.addLink();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, link.token)) && admitted(server).has(adm(server, kept.token)));
    const session = await open(server, link.token);
    const other = await open(server, kept.token);
    server.guests.host!.closeLink(link.id);
    server.guests.links = [kept];
    server.guests.host!.changed();
    await session.closed;
    expect(session.removed).toBe(true);
    expect(other.state).toBe("open");
    await waitFor(() => !admitted(server).has(adm(server, link.token)));
    expect(admitted(server).has(adm(server, kept.token))).toBe(true);
    await expect(viaRelay(server, link.token)).rejects.toEqual(new SessionClosed(4404));
    expect(`${LINK_DEVICE_PREFIX}${link.id}`).toMatch(/^link:[0-9a-f]{16}$/);
  });

  it("keeps phones and links together at twenty, and the admission set under what the relay takes (AC-16, AC-17)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-phone-relay-guests-full-"));
    cleanup.push(() => removeTempDir(dir));
    const seed = new SessionRegistry({ file: join(dir, "sessions.json") });
    const ids = Array.from({ length: 18 }, (_, n) => seed.issue({ label: `Phone ${n}`, scopes: ["client"] }).session.id);
    seed.close();
    writeFileSync(join(dir, PHONE_RELAY_PHONES_FILE), JSON.stringify({ v: 1, phones: ids }));
    const guests = new FakeGuests();
    for (let n = 0; n < 6; n += 1) guests.addLink();
    for (let n = 0; n < 5; n += 1) guests.addInvite();
    const server = await startServer({ dir, guests });
    server.guests.host!.changed();
    // 18 phones keep their slots; of 6 links two fit under 20; two of the 5 invites stand as windows.
    server.sessions.openPairing({ scopes: ["client"] });
    server.sessions.openPairing({ scopes: ["client"] });
    server.guests.host!.changed();
    await waitFor(() => admitted(server).size === 18 + 2 + 2 + 2);
    expect(server.phoneRelay.status()).toMatchObject({ phones: 18, maxPhones: MAX_RELAY_PHONES });
    expect(admitted(server).has(adm(server, guests.links[0]!.token))).toBe(true);
    expect(admitted(server).has(adm(server, guests.links[1]!.token))).toBe(true);
    expect(admitted(server).has(adm(server, guests.links[2]!.token))).toBe(false);
    expect(admitted(server).has(adm(server, guests.invites[1]!))).toBe(true);
    expect(admitted(server).has(adm(server, guests.invites[2]!))).toBe(false);
    // Phones and links fill the twenty: a phone that wants to pair is refused.
    const opened = server.sessions.openPairing({ scopes: ["client"] });
    server.phoneRelay.invite(opened.credential, "VPS", null);
    const session = await open(server, opened.credential);
    const refused = await http(session, "POST", "/api/pair", { body: JSON.stringify({ credential: opened.credential }), headers: asJson });
    expect(refused.status).toBe(409);
    expect(server.guests.host!.room()).toEqual({ devices: 18, links: 6 });
  });

  it("keeps sixteen phones, four links, two phone windows and two invites in one set of twenty-four (AC-16)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-phone-relay-guests-set-"));
    cleanup.push(() => removeTempDir(dir));
    const seed = new SessionRegistry({ file: join(dir, "sessions.json") });
    const ids = Array.from({ length: 16 }, (_, n) => seed.issue({ label: `Phone ${n}`, scopes: ["client"] }).session.id);
    seed.close();
    writeFileSync(join(dir, PHONE_RELAY_PHONES_FILE), JSON.stringify({ v: 1, phones: ids }));
    const guests = new FakeGuests();
    for (let n = 0; n < 4; n += 1) guests.addLink();
    guests.addInvite();
    guests.addInvite();
    const server = await startServer({ dir, guests });
    server.sessions.openPairing({ scopes: ["client"] });
    server.sessions.openPairing({ scopes: ["client"] });
    server.guests.host!.changed();
    await waitFor(() => admitted(server).size === 24);
    expect(admitted(server).size).toBeLessThanOrEqual(32);
    expect(server.phoneRelay.status().phones).toBe(16);
  });

  it("gives a link's streams the longer deadline and a phone's the shorter", async () => {
    const server = await startServer({ streamDeadlines: { headersMs: 300, requestMs: 600 } });
    const link = server.guests.addLink();
    server.guests.host!.changed();
    await waitFor(() => admitted(server).has(adm(server, link.token)));
    const phone = await pairPhone(server);
    const linkSession = await open(server, link.token);
    const stalls = (session: E2ESession<never>) => {
      const stream = session.openStream();
      let ended = false;
      stream.on("data", () => {});
      stream.on("error", () => {});
      stream.once("end", () => (ended = true));
      stream.write("GET /api/health HTTP/1.1\r\nHost: peer\r\n");
      return { ended: () => ended, stream };
    };
    const onPhone = stalls(phone.session);
    const onLink = stalls(linkSession);
    await waitFor(() => (onPhone.ended() ? true : null), 3_000);
    expect(onLink.ended()).toBe(false);
    onLink.stream.destroy();
  });
});
