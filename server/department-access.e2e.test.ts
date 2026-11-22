import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let BASE: string;
const posixOnly = describe.skipIf(process.platform === "win32");
const BOSS = "boss@example.test";
const ADA = "ada@example.test";
const BOB = "bob@example.test";
const CAPABILITY_KEY = "bot-visibility-fixture-capability";

let child: ChildProcess;
let home: string;
let log = "";
const tokens: Record<string, string> = {};

const headers = (as?: string, json = true) => ({
  ...(json ? { "content-type": "application/json" } : {}),
  ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
});
const api = async (method: string, path: string, body?: unknown, as?: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(as, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function start() {
  const port = await freePortBlock([0, 1]);
  BASE = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "hold-search-result.ts")).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, SEIRA_PORT: String(port), SEIRA_WEBHOOK_PORT: String(port + 1),
      SEIRA_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (log += c));
  child.stderr!.on("data", (c) => (log += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitFor<T>(read: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** `lastEventId` resumes from a cursor the way a browser's EventSource does. */
function openStream(as: string, lastEventId?: string) {
  const controller = new AbortController();
  const frames: any[] = [];
  const state: { hello: any; ended: boolean; cursor?: string } = { hello: null, ended: false };
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { ...headers(as, false), ...(lastEventId ? { "last-event-id": lastEventId } : {}) },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id: ")) state.cursor = line.slice(4);
            if (!line.startsWith("data: ")) continue;
            const frame = JSON.parse(line.slice(6));
            if (frame.kind === "hello") {
              state.hello = frame;
              state.cursor = frame.cursor;
            } else if (frame.kind !== "ping") frames.push(frame);
          }
        }
      }
      state.ended = true;
    } catch {
    }
  })();
  return { frames, state, ready: () => waitFor(() => state.hello, 10_000), close: () => controller.abort() };
}

const ids = { sales: "", fin: "" };

async function makeBot(name: string, section: string) {
  const created = await api("POST", "/api/bots", { name, section }, BOSS);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as { id: string; threadId: string };
}

posixOnly("a person limited to some departments", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "seira-department-access-"));
    const data = join(home, ".seira");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      signIn: { admins: [BOSS], members: [ADA, BOB] },
      instances: { grok: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false } } },
    }));
    const role = (email: string) => (email === BOSS ? ["admin", "client"] as const : ["client"] as const);
    const registry = new SessionRegistry({ file: join(data, "sessions.json"), emailScopes: (email) => [...role(email)] });
    for (const email of [BOSS, ADA, BOB]) tokens[email] = registry.issue({ label: `${email.split("@")[0]}'s laptop`, email, scopes: [...role(email)] }).token;
    registry.close();
    await start();
    const sales = await makeBot("Sales Otter", "Sales");
    const fin = await makeBot("Finance Zebra", "Finance");
    ids.sales = sales.id;
    ids.fin = fin.id;
  }, 90_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("does not resume a stream that a change of access closed, and gets a fresh snapshot", async () => {
    expect((await api("PUT", "/api/department-access", { entry: ADA, departments: ["Sales"] }, BOSS)).status).toBe(200);
    let ada = openStream(ADA);
    try {
      expect(await ada.ready()).toBeTruthy();
      expect((await api("GET", "/api/bots?messages=5", undefined, ADA)).body.bots.map((bot: any) => bot.id)).toEqual([ids.sales]);
      const away = ada.state.cursor;
      expect((await api("PUT", "/api/department-access", { entry: ADA, departments: ["Finance"] }, BOSS)).status).toBe(200);
      expect(await waitFor(() => ada.state.ended)).toBe(true);
      ada = openStream(ADA, away);
      expect((await ada.ready())?.resumed).toBe(false);
      expect((await api("GET", "/api/bots?messages=5", undefined, ADA)).body.bots.map((bot: any) => bot.id)).toEqual([ids.fin]);
    } finally {
      ada.close();
    }
  }, 60_000);

  it("is sent no name of a bot or a department outside the grant in the pause lists", async () => {
    expect((await api("PUT", "/api/department-access", { entry: ADA, departments: ["Sales"] }, BOSS)).status).toBe(200);
    expect((await api("POST", "/api/paused", { kind: "bot", id: ids.fin, paused: true }, BOSS)).status).toBe(200);
    expect((await api("POST", "/api/paused", { kind: "department", id: "Finance", paused: true }, BOSS)).status).toBe(200);
    expect((await api("POST", "/api/paused", { kind: "bot", id: ids.sales, paused: true }, BOSS)).status).toBe(200);
    const ada = (await api("GET", "/api/config", undefined, ADA)).body;
    expect(ada.heldBots).toEqual([ids.sales]);
    expect(ada.pausedByPerson.bots).toEqual([ids.sales]);
    expect(ada.pausedByPerson.departments).toEqual([]);
    expect(JSON.stringify(ada)).not.toContain(ids.fin);
    const boss = (await api("GET", "/api/config", undefined, BOSS)).body;
    expect(boss.heldBots).toContain(ids.fin);
    expect(boss.pausedByPerson.departments).toEqual(["Finance"]);
    const frame = openStream(ADA);
    try {
      expect(await frame.ready()).toBeTruthy();
      expect((await api("POST", "/api/paused", { kind: "bot", id: ids.sales, paused: false }, BOSS)).status).toBe(200);
      const config = await waitFor(() => frame.frames.find((f) => f.kind === "config"));
      expect(config?.pausedByPerson.departments).toEqual([]);
      expect(JSON.stringify(config)).not.toContain(ids.fin);
    } finally {
      frame.close();
    }
  }, 60_000);
});
