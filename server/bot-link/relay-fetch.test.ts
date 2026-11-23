// fetchOverSession against the fake relay: a paired reference phone holds the session, and the server side answers every
// stream with a handler that stands in for the link routes.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { admission, b64u, credentialHash, ed25519RawPublicKey, fromB64u, keyId, mintRelayToken, psk } from "../../companion/src/e2e/credentials.ts";
import { TRANSPORT_RELAY } from "../../companion/src/e2e/noise.ts";
import { dial } from "../../companion/src/e2e/phone.ts";
import { SessionClosed, type E2ESession } from "../../companion/src/e2e/session.ts";
import { startFakeRelay } from "../../companion/test/e2e/fake-relay.ts";
import { http, json, waitFor } from "../../companion/test/e2e/rig.ts";
import { startPhoneRelay, type PhoneRelay } from "../phone-relay.ts";
import { SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { fetchOverSession } from "./relay-fetch.ts";

const MIB = 1024 * 1024;
const signingKey = generateKeyPairSync("ed25519").privateKey;
const keys = new Map([["k1", ed25519RawPublicKey(signingKey)]]);

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const pattern = (bytes: number): Buffer => Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 31 + 7) & 0xff));
const sha = (data: Buffer | Uint8Array): string => createHash("sha256").update(data).digest("hex");

interface Rig {
  session: E2ESession<never>;
  fetch: typeof fetch;
  /** Requests the server side has received and not yet finished. */
  open(): number;
  release(): void;
  seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"] }>;
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "seira-relay-fetch-"));
  cleanup.push(() => removeTempDir(dir));
  const relay = await startFakeRelay({ keys });
  cleanup.push(() => relay.close());
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  cleanup.push(() => sessions.close());
  const hostId = randomBytes(16);
  const iat = Math.floor(Date.now() / 1000);
  const grant = { token: mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: "test-install", iat, exp: iat + 43_200 }, signingKey), hostId: b64u(hostId), nodes: ["relay1.seira.bot"], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000 };

  let open = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: Rig["seen"] = [];
  const send = (res: ServerResponse, status: number, payload: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    open += 1;
    res.once("close", () => { open -= 1; console.log("DBG res close", req.url); });
    req.socket.once("close", () => console.log("DBG socket close", req.url));
    req.once("close", () => console.log("DBG req close", req.url));
    for (const ev of ["end", "finish", "error", "pause", "drain"]) req.socket.on(ev, () => console.log("DBG socket", ev, req.url));
    setTimeout(() => console.log("DBG state", req.url, req.socket.destroyed, req.socket.readableEnded, req.socket.writableEnded), 1500);
    const url = new URL(req.url ?? "/", "http://server");
    seen.push({ method: req.method ?? "", url: `${url.pathname}${url.search}`, headers: req.headers });
    if (req.method === "POST" && url.pathname === "/api/pair") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const credential = (JSON.parse(raw) as { credential: string }).credential;
      const paired = sessions.exchange({ code: credential, label: "Pixel", source: "test" });
      return paired.ok ? send(res, 200, { token: paired.token }) : send(res, paired.status, { error: paired.error });
    }
    if (url.pathname === "/echo") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return send(res, 201, { method: req.method, query: url.search, type: req.headers["content-type"], custom: req.headers["x-custom"], body: Buffer.concat(chunks).toString("utf8") });
    }
    if (url.pathname === "/held") {
      await gate;
      return send(res, 200, { released: true });
    }
    if (url.pathname === "/upload") {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of req) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
      return send(res, 200, { bytes, sha: hash.digest("hex"), length: req.headers["content-length"] });
    }
    if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(5 * MIB) });
      return void Readable.from(pattern(5 * MIB), { objectMode: false }).pipe(res);
    }
    if (url.pathname === "/trickle") {
      res.writeHead(200, { "content-type": "text/plain" });
      const tick = setInterval(() => res.write("tick\n"), 10);
      res.once("close", () => clearInterval(tick));
      return;
    }
    if (url.pathname === "/redirect") return void res.writeHead(302, { location: "https://elsewhere.example/" }).end();
    if (url.pathname === "/empty") return void res.writeHead(204).end();
    if (url.pathname === "/not-modified") return void res.writeHead(304, { etag: '"x"' }).end();
    return send(res, 404, { error: "not here" });
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

  const dialWith = (credential: string, k: Buffer) => dial({
    url: `${relay.url}/v1/phone`, transportByte: TRANSPORT_RELAY, remoteStatic: k, psk: psk(credentialHash(credential), keyId(k)), app: "test/1",
    relay: { hostId, adm: admission(credentialHash(credential), hostId) },
  });
  const opened = sessions.openPairing({ scopes: ["client"] });
  const link = started.invite(opened.credential, "VPS", null)!;
  const k = fromB64u(JSON.parse(fromB64u(new URL(link).searchParams.get("e2e")!)!.toString("utf8")).k)!;
  const pairing = await waitFor(() => dialWith(opened.credential, k).catch(() => null), 6_000);
  const paired = await http(pairing, "POST", "/api/pair", { body: JSON.stringify({ credential: opened.credential }), headers: { "content-type": "application/json" } });
  const token = json(paired).token as string;
  pairing.shutdown();
  const session = await waitFor(() => dialWith(token, k).catch(() => null), 6_000);
  cleanup.push(() => session.shutdown());
  seen.length = 0;
  return { session, fetch: fetchOverSession(() => Promise.resolve(session)), open: () => open, release, seen };
}

const ORIGIN = "https://h-00112233445566778899aabbccddeeff.e2e.invalid";
const noStreams = (r: Rig) => waitFor(() => (r.session.activeStreams === 0 && r.open() === 0 ? true : null), 5_000).catch((e) => { throw new Error(`${e.message} client=${r.session.activeStreams} server=${r.open()}`); });

describe("fetchOverSession", () => {
  it("posts JSON and reads the answer, and sends only the path and the query", async () => {
    const r = await rig();
    const answer = await r.fetch(`${ORIGIN}/echo?a=1&b=two`, { method: "POST", headers: { "content-type": "application/json", "x-custom": "yes" }, body: JSON.stringify({ hello: "world" }) });
    expect(answer.status).toBe(201);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(await answer.json()).toEqual({ method: "POST", query: "?a=1&b=two", type: "application/json", custom: "yes", body: '{"hello":"world"}' });
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.url).toBe("/echo?a=1&b=two");
    expect(r.seen[0]!.headers.host).toBe("phone-relay.invalid");
    await noStreams(r);
  });

  it("opens one stream for each call and closes it with the answer", async () => {
    const r = await rig();
    const answers = await Promise.all([1, 2, 3].map((n) => r.fetch(`${ORIGIN}/echo?n=${n}`, { method: "POST", body: String(n) }).then((a) => a.json() as Promise<{ body: string }>)));
    expect(answers.map((a) => a.body)).toEqual(["1", "2", "3"]);
    await noStreams(r);
  });

  it("waits for an answer that is held, and delivers it when it comes", async () => {
    const r = await rig();
    const pending = r.fetch(`${ORIGIN}/held`).then((a) => a.json());
    await waitFor(() => (r.open() === 1 ? true : null), 5_000);
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    r.release();
    expect(await pending).toEqual({ released: true });
    await noStreams(r);
  });

  it("rejects an abort while the answer is held and leaves no stream open", async () => {
    const r = await rig();
    const controller = new AbortController();
    const pending = r.fetch(`${ORIGIN}/held`, { signal: controller.signal });
    await waitFor(() => (r.open() === 1 ? true : null), 5_000);
    const reason = new Error("stop waiting");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await noStreams(r);
    expect((await r.fetch(`${ORIGIN}/echo`)).status).toBe(201);
  });

  it("rejects at once when the signal was aborted before the call, and opens nothing", async () => {
    const r = await rig();
    await expect(r.fetch(`${ORIGIN}/echo`, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(r.session.activeStreams).toBe(0);
    expect(r.seen).toHaveLength(0);
  });

  it("fails a body that is still coming when the call is aborted, and leaves no stream open", async () => {
    const r = await rig();
    const controller = new AbortController();
    const answer = await r.fetch(`${ORIGIN}/trickle`, { signal: controller.signal });
    expect(answer.status).toBe(200);
    const reader = answer.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort(new Error("enough"));
    await expect((async () => { for (;;) { if ((await reader.read()).done) return; } })()).rejects.toThrow();
    await noStreams(r);
  });

  it("puts a 5 MiB Blob whole", async () => {
    const r = await rig();
    const data = pattern(5 * MIB);
    const answer = await r.fetch(`${ORIGIN}/upload?name=big`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Blob([data]) });
    expect(await answer.json()).toEqual({ bytes: 5 * MIB, sha: sha(data), length: String(5 * MIB) });
    await noStreams(r);
  }, 30_000);

  it("gets a 5 MiB body as a stream, whole", async () => {
    const r = await rig();
    const answer = await r.fetch(`${ORIGIN}/big`);
    expect(answer.status).toBe(200);
    const received = Buffer.from(await answer.arrayBuffer());
    expect(received.length).toBe(5 * MIB);
    expect(sha(received)).toBe(sha(pattern(5 * MIB)));
    await noStreams(r);
  }, 30_000);

  it("rejects an answer that redirects", async () => {
    const r = await rig();
    await expect(r.fetch(`${ORIGIN}/redirect`, { redirect: "error" })).rejects.toThrow(/redirect/);
    await noStreams(r);
  });

  it("answers 204 and 304 with no body", async () => {
    const r = await rig();
    const empty = await r.fetch(`${ORIGIN}/empty`);
    expect([empty.status, empty.body]).toEqual([204, null]);
    const same = await r.fetch(`${ORIGIN}/not-modified`);
    expect([same.status, same.body, same.headers.get("etag")]).toEqual([304, null, '"x"']);
    await noStreams(r);
  });

  it("rejects a call after the session closed, and the session refuses a new stream", async () => {
    const r = await rig();
    r.session.shutdown();
    await r.session.closed;
    expect(() => r.session.openStream()).toThrow(SessionClosed);
    await expect(r.fetch(`${ORIGIN}/echo`)).rejects.toBeInstanceOf(SessionClosed);
  });

  it("rejects a body that is not a string or a Blob, and a Request", async () => {
    const r = await rig();
    await expect(r.fetch(`${ORIGIN}/echo`, { method: "POST", body: new Uint8Array(2) })).rejects.toThrow(TypeError);
    await expect(r.fetch(new Request(`${ORIGIN}/echo`))).rejects.toThrow(TypeError);
    expect(r.session.activeStreams).toBe(0);
  });
});
