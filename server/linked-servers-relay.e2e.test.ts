// Two real servers on this machine. The inviting one has no public address and reaches the other only through a fake
// Seira Relay; a fake control plane gives it a relay grant. One bot hands work across the link and the result comes back.
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runControlSeira, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-seira.ts";
import { b64u, ed25519RawPublicKey, mintRelayToken } from "../companion/src/e2e/credentials.ts";
import { startFakeRelay, type FakeRelay } from "../companion/test/e2e/fake-relay.ts";
import { waitFor } from "../companion/test/e2e/rig.ts";
import { decodeAnyInvite } from "./host/linked-servers-store.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

type Json = Record<string, unknown>;
type Message = { kind?: string; role?: string; text?: string; roomRequest?: { phase?: string }; tool?: { name?: string; output?: string } };
type LinkRow = { id: string; name: string; role: string; state: string; route: string; exposed: string[]; bots: Array<{ id: string; name: string }> };
type Bot = { id: string; name: string; activeTaskId: string };

const FAKE_CLI = new URL("./testing/fake-claude-cli.ts", import.meta.url).pathname;
const signingKey = generateKeyPairSync("ed25519").privateKey;
const hostId = randomBytes(16);
const credential = `seira_install_${randomBytes(16).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
const CANARY = "canary-orders-7f3a9c";

let relay: FakeRelay;
let controlPlane: Server;
const captured: Buffer[] = [];
const started: Array<{ child: ChildProcess; dataDir: string }> = [];

/** A real server with the fake engine, which plans its turns from a file. `relayServer`: it serves through Seira Relay. */
async function boot(name: string, relayServer: boolean) {
  const port = await freePortBlock([0, 1]);
  const dataDir = mkdtempSync(join(tmpdir(), `seira-link-relay-${name}-`));
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const planPath = join(dataDir, "room-plan.json");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false },
    instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_ROOM_PLAN: planPath } } },
  }));
  if (relayServer) writeFileSync(join(dataDir, "tunnel-account.json"), JSON.stringify({ companionInstallationCredential: credential }), { mode: 0o600 });
  const env = {
    ...verificationServerEnvironment(process.env, dataDir, port),
    SEIRA_PHONE_RELAY_URL: relay.url,
    ...(relayServer ? { SEIRA_PHONE_RELAY: "1", SEIRA_CONTROL_PLANE_URL: `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}` } : {}),
  };
  const log = openSync(join(dataDir, "server.log"), "a", 0o600);
  const child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log] });
  closeSync(log);
  started.push({ child, dataDir });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/api/health`).then((r) => r.json(), () => null) as { app?: string } | null)?.app === "seira", 30_000);

  const plans: Record<string, { turns: unknown[] }> = {};
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as Json };
  };
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const answer = await call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBe(status);
    return answer.body;
  };
  return {
    url, dataDir, api, call,
    cli: (...args: string[]) => runControlSeira([...args, "--url", url]) as Promise<Json>,
    plan(botId: string, ...turns: unknown[]) { (plans[botId] ??= { turns: [] }).turns.push(...turns); writeFileSync(planPath, JSON.stringify(plans)); },
    providerTurns: (): Array<{ botId: string }> => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    messages: async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Message[],
    links: async () => (await api("GET", "/api/linked-servers")).servers as LinkRow[],
  };
}
type Place = Awaited<ReturnType<typeof boot>>;

beforeAll(async () => {
  relay = await startFakeRelay({ keys: new Map([["k1", ed25519RawPublicKey(signingKey)]]), tamper: (_direction, data) => { captured.push(Buffer.from(data)); return data; } });
  controlPlane = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.method !== "POST" || req.url !== "/v1/installations/self/relay-token" || req.headers.authorization !== `Bearer ${credential}`) {
      return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    }
    const iat = Math.floor(Date.now() / 1000);
    const token = mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: "test-install", iat, exp: iat + 43_200 }, signingKey);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      token, hostId: b64u(hostId), nodes: ["relay1.seira.bot"], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000,
    }));
  });
  await new Promise<void>((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));
}, 30_000);

afterAll(async () => {
  for (const one of started) {
    await waitForExit(one.child, { signal: "SIGTERM", graceMs: 15_000 });
    await removeTempDir(one.dataDir);
  }
  await relay?.close();
  await new Promise((resolve) => controlPlane?.close(resolve));
}, 90_000);

describe("a guest link through Seira Relay between two servers", () => {
  let head: Place, branch: Place;
  let atlas: Bot, writer: Bot;
  let atlasAddress = "";
  let invite = "";

  beforeAll(async () => {
    head = await boot("head", true);
    branch = await boot("branch", false);
    await head.api("PATCH", "/api/config", { computerName: "Head office" });
    await branch.api("PATCH", "/api/config", { computerName: "Branch office" });
    atlas = (await head.cli("new-bot", "--name", "Atlas")).bot as Bot;
    writer = (await branch.cli("new-bot", "--name", "Writer")).bot as Bot;
    await waitFor(async () => ((await head.api("GET", "/api/auth/pairing")).relay as { relay?: string } | undefined)?.relay === "connected", 60_000);
  }, hostTimeout(180_000));

  it("makes a version 2 invite on a server with no public address, and joins with it", async () => {
    const made = await head.api("POST", "/api/linked-servers/invites");
    invite = String(made.invite);
    expect(decodeAnyInvite(invite), invite).toMatchObject({ v: 2, name: "Head office" });
    const joined = (await branch.api("POST", "/api/linked-servers/join", { invite })).server as LinkRow;
    expect(joined).toMatchObject({ name: "Head office", role: "joiner", route: "relay" });
    await expect.poll(async () => (await head.links())[0], { timeout: 30_000 }).toMatchObject({ name: "Branch office", role: "inviter", state: "online", route: "relay" });
    await expect.poll(async () => (await branch.links())[0], { timeout: 30_000 }).toMatchObject({ name: "Head office", role: "joiner", state: "online", route: "relay" });
  }, hostTimeout(90_000));

  it("shows an exposed bot on the other server, hands work to it, and returns the result", async () => {
    const [mine] = await head.links();
    await head.api("PATCH", `/api/linked-servers/${mine!.id}`, { exposed: [atlas.id] });
    await expect.poll(async () => (await branch.links())[0]!.bots, { timeout: 30_000 }).toEqual([{ id: expect.stringMatching(new RegExp(`^link-[0-9a-f]{8}-${atlas.id}$`, "u")), name: "Atlas" }]);
    atlasAddress = (await branch.links())[0]!.bots[0]!.id;

    head.plan(atlas.id, { reply: "Atlas counted 42 orders." });
    branch.plan(writer.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [atlasAddress], request_key: "count", message: `Count this week's orders. ${CANARY}` } }], reply: "Asked Atlas." },
      { reply: "Atlas says 42." });
    await branch.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Ask Atlas for this week's order count.");
    await expect.poll(() => head.providerTurns().find((turn) => turn.botId === atlas.id), { timeout: 60_000 }).toBeTruthy();
    expect((await branch.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "60")).status).toBe("settled");
    await expect.poll(async () => (await branch.messages(writer.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /42 orders/u.test(message.tool?.output ?? "")), { timeout: 30_000 }).toBe(true);

    const received = readHandoffs(head.dataDir).filter((node) => node.botId === atlas.id);
    expect(received).toHaveLength(1);
    expect(received[0]!.origin?.kind).toBe("outside");
    expect(received[0]!.text).toContain(CANARY);
  }, hostTimeout(180_000));

  it("keeps the hand-off off the relay in plain words, and ends the link on both sides when the inviting server removes it", async () => {
    const seen = Buffer.concat(captured);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.includes(Buffer.from(CANARY))).toBe(false);
    expect(seen.includes(Buffer.from(invite))).toBe(false);

    const [mine] = await head.links();
    await head.api("DELETE", `/api/linked-servers/${mine!.id}`);
    expect(await head.links()).toEqual([]);
    await expect.poll(async () => (await branch.links())[0]?.state, { timeout: 60_000 }).toMatch(/^(ended|offline)$/u);
    expect((await branch.links())[0]!.bots).toEqual([]);
  }, hostTimeout(120_000));
});
