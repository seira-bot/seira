import { createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  parsePhoneWorkspaceSwitchProof,
  phoneWorkspaceSwitchProofMessage,
  phoneWorkspaceSwitchProofRoute,
  type PhoneWorkspaceSwitchProofFields,
} from "../../packages/phone-protocol/src/workspaces.ts";
import { b64u, fromB64u, keyId } from "../src/e2e/credentials.ts";
import { generateKeyPair, type KeyPair } from "../src/e2e/noise.ts";
import { createE2EOrigin } from "../src/e2e/origin.ts";
import type { E2EContext } from "../src/e2e/registry.ts";
import { PROOF_TTL_MS, switchProofMessage, switchProofSigner } from "../src/e2e/switch-proof.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { createWorkspaces, WORKSPACE_SWITCH_RESULT_MESSAGE, WORKSPACES_MESSAGE } from "../src/workspaces.ts";

const TOKEN = "seira_test_token";
const ENV_LOCAL = "0b1e6a52-4f7c-4a0e-9d8c-3a5f2b7c9e11";
const ENV_WORK = "7d3f9c14-8a2b-4c5e-b6d7-1e9a0f3c5b28";
const ENV_COPY = "11111111-2222-4333-8444-555555555555";
const OPERATION = /^[0-9a-f]{32}$/;

const transportKey: KeyPair = generateKeyPair();
const signer = switchProofSigner(transportKey);

const BEFORE = [
  { id: "local", environmentId: ENV_LOCAL, name: "This PC", current: true, state: "ready" },
  { id: "work", environmentId: ENV_WORK, name: "Work", current: false, state: "ready" },
];
/** The list the app sends after the switch finished: the target is open. */
const AFTER = [
  { id: "local", environmentId: ENV_LOCAL, name: "This PC", current: false, state: "ready" },
  { id: "work", environmentId: ENV_WORK, name: "Work", current: true, state: "ready" },
];

let harness: Server;
let harnessHits: string[] = [];
let sidecar: Server;
let origin: ReturnType<typeof createE2EOrigin>;
let clock = 1_000_000;
let allowed = true;
let workspaces = createWorkspaces({ send: () => {}, settleMs: 5, now: () => clock });

const facts = (list: unknown) => workspaces.receive({ type: WORKSPACES_MESSAGE, workspaces: list });
const ended = (id: string, outcome: string) => workspaces.receive({ type: WORKSPACE_SWITCH_RESULT_MESSAGE, id, outcome });

beforeAll(async () => {
  harness = createServer((req, res) => {
    harnessHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const proxy = createProxyHandler({
    harnessPort: (harness.address() as AddressInfo).port,
    authenticate: (token) => (token === TOKEN ? { id: "device-1", cloudDesktopAccess: false, browserControlAccess: false, otherWorkspaces: true } : null),
    redeem: () => ({ error: "no", code: "pairing_invalid" }) as never,
    serverName: () => "Test computer",
    workspaces: {
      list: () => workspaces.list(),
      switchTo: (body, owner) => workspaces.switchTo(body, owner),
      operation: (id, owner) => workspaces.operation(id, owner),
      proof: (id, owner, body, context) => workspaces.proof(id, owner, body, context),
    },
    proofSigner: () => signer,
    otherWorkspacesAllowed: (deviceId) => allowed && (deviceId === "device-1" || deviceId === "device-2"),
  });
  origin = createE2EOrigin((req, res) => proxy(req, res, "origin"), (_req, socket) => socket.destroy());
  sidecar = createServer((req, res) => proxy(req, res, "lan"));
  await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  origin.close();
  sidecar.closeAllConnections();
  await Promise.all([sidecar, harness].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

beforeEach(() => {
  harnessHits = [];
  clock = 1_000_000;
  allowed = true;
  workspaces = createWorkspaces({ send: () => {}, settleMs: 5, now: () => clock });
});

/** A request through an encrypted-session stream: the same handler, reached in memory, with this context. */
async function viaSession(context: E2EContext, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const stream = await origin.connect(context);
  const payload = JSON.stringify(body);
  const head = [`POST ${path} HTTP/1.1`, "host: computer", "connection: close", "content-type: application/json", `content-length: ${Buffer.byteLength(payload)}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
  stream.write(head + payload);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("close", resolve);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  const [header, ...rest] = text.split("\r\n\r\n");
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(header)?.[1]);
  const raw = rest.join("\r\n\r\n");
  const json = raw ? JSON.parse(raw.replace(/^[0-9a-f]+\r\n/, "").replace(/\r\n0\r\n\r\n$/, "")) : null;
  return { status, json };
}

function plain(path: string, body: unknown, token: string | null): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port: (sidecar.address() as AddressInfo).port, path, method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } },
      (res: IncomingMessage) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const binding = randomBytes(32);
const device = (id = "device-1", bind: Buffer = binding): E2EContext => ({ peer: { kind: "device", id }, route: "wifi", binding: bind });
const nonce = () => randomBytes(32);

/** The switch to "work", as the phone starts it: the operation id. */
async function startSwitch(): Promise<string> {
  facts(BEFORE);
  const started = await workspaces.switchTo({ id: "work" }, "device-1");
  const id = (started.body as { switch: { id: string } }).switch.id;
  expect(id).toMatch(OPERATION);
  return id;
}

async function finishedSwitch(): Promise<string> {
  const id = await startSwitch();
  ended(id, "done");
  facts(AFTER);
  return id;
}

const ask = (id: string, n: Buffer = nonce(), context: E2EContext = device()) => viaSession(context, phoneWorkspaceSwitchProofRoute(id), { nonce: b64u(n) });

describe("the proof that a workspace switch finished", () => {
  it("signs the finished switch with the transport key, for this session, and the phone can check it", async () => {
    const id = await finishedSwitch();
    const n = nonce();
    const { status, json } = await ask(id, n);
    expect(status).toBe(200);
    // Minimum fields only, and no bearer was needed or forwarded.
    expect(Object.keys(json)).toEqual(["proof"]);
    expect(Object.keys(json.proof).sort()).toEqual(["environmentId", "expiresAt", "fromEnvironmentId", "fromWorkspaceId", "issuedAt", "operationId", "signature", "v", "workspaceId"]);
    expect(harnessHits).toEqual([]);
    const proof = parsePhoneWorkspaceSwitchProof(json);
    expect(proof).toMatchObject({ v: 1, operationId: id, fromWorkspaceId: "local", fromEnvironmentId: ENV_LOCAL, workspaceId: "work", environmentId: ENV_WORK, issuedAt: clock });
    expect(proof!.expiresAt).toBe(clock + PROOF_TTL_MS);
    // The phone rebuilds the bytes from what it knows (pinned key, its own session hash and device id, its nonce) and verifies with T.pub.
    const fields: PhoneWorkspaceSwitchProofFields = {
      keyId: keyId(transportKey.publicKey),
      binding,
      deviceId: "device-1",
      operationId: proof!.operationId,
      fromWorkspaceId: proof!.fromWorkspaceId,
      fromEnvironmentId: proof!.fromEnvironmentId,
      workspaceId: proof!.workspaceId,
      environmentId: proof!.environmentId,
      nonce: n,
      issuedAt: proof!.issuedAt,
      expiresAt: proof!.expiresAt,
    };
    const message = phoneWorkspaceSwitchProofMessage(fields);
    expect(Buffer.from(message).equals(switchProofMessage(fields))).toBe(true);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(transportKey.publicKey.subarray(1, 33)), y: b64u(transportKey.publicKey.subarray(33, 65)) }, format: "jwk" });
    const signature = fromB64u(proof!.signature)!;
    expect(signature.length).toBe(64);
    const check = (bytes: Uint8Array) => verify("sha256", bytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    expect(check(message)).toBe(true);
    // Another session, another nonce, another environment, another device or another key: no match.
    expect(check(phoneWorkspaceSwitchProofMessage({ ...fields, binding: randomBytes(32) }))).toBe(false);
    expect(check(phoneWorkspaceSwitchProofMessage({ ...fields, nonce: nonce() }))).toBe(false);
    expect(check(phoneWorkspaceSwitchProofMessage({ ...fields, environmentId: ENV_COPY }))).toBe(false);
    expect(check(phoneWorkspaceSwitchProofMessage({ ...fields, deviceId: "device-2" }))).toBe(false);
    const stranger = generateKeyPair();
    const other = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(stranger.publicKey.subarray(1, 33)), y: b64u(stranger.publicKey.subarray(33, 65)) }, format: "jwk" });
    expect(verify("sha256", message, { key: other, dsaEncoding: "ieee-p1363" }, signature)).toBe(false);
  });

  it("answers a proof once for each switch: a repeated or replayed challenge is refused", async () => {
    const id = await finishedSwitch();
    expect((await ask(id)).status).toBe(200);
    const again = await ask(id);
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: "proof_used" });
    expect((await ask(id, nonce(), device("device-1", randomBytes(32)))).json).toEqual({ error: "proof_used" });
  });

  it("refuses a proof after the switch expired, and for a wrong or unknown operation", async () => {
    const id = await finishedSwitch();
    expect((await ask("0".repeat(32))).json).toEqual({ error: "switch_not_found" });
    expect((await ask("not-an-operation")).json).toEqual({ error: "switch_not_found" });
    clock += 30 * 60_000 + 1;
    expect((await ask(id)).json).toEqual({ error: "switch_not_found" });
  });

  it("caps a proof by the end of its operation", async () => {
    const id = await finishedSwitch();
    clock += 30 * 60_000 - 1_000;
    const { json } = await ask(id);
    expect(json.proof.expiresAt).toBe(1_000_000 + 30 * 60_000);
  });

  it("gives no proof for a switch that is pending, failed, cancelled or superseded", async () => {
    const pending = await startSwitch();
    expect((await ask(pending)).json).toEqual({ error: "switch_not_done" });
    for (const outcome of ["failed", "cancelled", "superseded"]) {
      const id = await startSwitch();
      ended(id, outcome);
      facts(AFTER);
      const reply = await ask(id);
      expect(reply.status, outcome).toBe(409);
      expect(reply.json, outcome).toEqual({ error: "switch_not_done" });
    }
  });

  it("gives no proof when the target is not the open workspace, or its environment is not the one that was named", async () => {
    const id = await startSwitch();
    ended(id, "done");
    facts(BEFORE);
    expect((await ask(id)).json).toEqual({ error: "switch_not_provable" });
    facts(AFTER.map((w) => (w.id === "work" ? { ...w, environmentId: ENV_COPY } : w)));
    expect((await ask(id)).json).toEqual({ error: "switch_not_provable" });
    facts(AFTER.map((w) => (w.id === "work" ? { ...w, environmentId: undefined } : w)));
    expect((await ask(id)).json).toEqual({ error: "switch_not_provable" });
  });

  it("names the environment the workspace shows after it ran, when it had none at the start", async () => {
    facts(BEFORE.map((w) => (w.id === "work" ? { ...w, environmentId: undefined } : w)));
    const started = await workspaces.switchTo({ id: "work" }, "device-1");
    const id = (started.body as { switch: { id: string } }).switch.id;
    ended(id, "done");
    facts(AFTER);
    const { status, json } = await ask(id);
    expect(status).toBe(200);
    expect(json.proof.environmentId).toBe(ENV_WORK);
  });

  it("gives a proof only to the phone that started the switch, inside its own session", async () => {
    const id = await finishedSwitch();
    expect((await ask(id, nonce(), device("device-2"))).status).toBe(404);
    // A session that has not paired yet may not ask.
    const pairing: E2EContext = { peer: { kind: "pairing", admHash: null }, route: "wifi", binding };
    expect((await ask(id, nonce(), pairing)).status).toBe(401);
    // A connection that is not an encrypted session, with or without a bearer, gets nothing.
    for (const token of [null, TOKEN]) {
      const reply = await plain(phoneWorkspaceSwitchProofRoute(id), { nonce: b64u(nonce()) }, token);
      expect(reply.status).toBe(403);
      expect(reply.json).toEqual({ error: "secure_channel_required" });
    }
    // A session that is open but has no handshake hash yet is not enough.
    expect((await ask(id, nonce(), { peer: { kind: "device", id: "device-1" }, route: "wifi" })).json).toEqual({ error: "secure_channel_required" });
    // A binding of the wrong length is not a handshake hash.
    expect((await ask(id, nonce(), { peer: { kind: "device", id: "device-1" }, route: "wifi", binding: Buffer.alloc(31, 1) })).json).toEqual({ error: "secure_channel_required" });
    expect(harnessHits).toEqual([]);
    // The switch is still provable by its owner: none of the above used it.
    expect((await ask(id)).status).toBe(200);
  });

  it("keeps the per-phone permission: a phone turned off, or unpaired, gets no proof", async () => {
    const id = await finishedSwitch();
    allowed = false;
    const reply = await ask(id);
    expect(reply.status).toBe(403);
    allowed = true;
    expect((await ask(id)).status).toBe(200);
  });

  it("refuses a nonce that is not 32 bytes of base64url, and uses no proof for it", async () => {
    const id = await finishedSwitch();
    for (const bad of [undefined, 5, "", "AAAA", b64u(randomBytes(31)), b64u(randomBytes(33)), "not base64!"]) {
      const reply = await viaSession(device(), phoneWorkspaceSwitchProofRoute(id), bad === undefined ? {} : { nonce: bad });
      expect(reply.status, String(bad)).toBe(400);
      expect(reply.json).toEqual({ error: "invalid_nonce" });
    }
    expect((await ask(id)).status).toBe(200);
  });

  it("gives no proof for a cancel", async () => {
    facts([{ ...BEFORE[0], current: false }, { ...BEFORE[1], state: "waiting", waitingFor: "Bot", current: true }]);
    const started = await workspaces.switchTo({ id: "work" }, "device-1");
    const id = (started.body as { switch: { id: string } }).switch.id;
    ended(id, "done");
    expect((await ask(id)).json).toEqual({ error: "switch_not_provable" });
  });

  it("signs with the transport key and nothing else: the signer's key id is the pinned key's id", () => {
    expect(signer.keyId.equals(keyId(transportKey.publicKey))).toBe(true);
  });
});

describe("the proof on the wire", () => {
  it("reads a proof and rejects any with a missing or malformed field", () => {
    const good = { v: 1, operationId: "a".repeat(32), fromWorkspaceId: "local", workspaceId: "work", environmentId: ENV_WORK, issuedAt: 1, expiresAt: 2, signature: "A".repeat(86) };
    expect(parsePhoneWorkspaceSwitchProof({ proof: good })).toEqual(good);
    expect(parsePhoneWorkspaceSwitchProof({ proof: { ...good, fromEnvironmentId: ENV_LOCAL.toUpperCase() } })?.fromEnvironmentId).toBe(ENV_LOCAL);
    for (const bad of [null, {}, { proof: null }, { proof: { ...good, v: 2 } }, { proof: { ...good, environmentId: "x" } }, { proof: { ...good, signature: "short" } }, { proof: { ...good, issuedAt: -1 } }, { proof: { ...good, operationId: undefined } }]) {
      expect(parsePhoneWorkspaceSwitchProof(bad)).toBeNull();
    }
  });
});
