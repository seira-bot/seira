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

  describe("an invite to chosen bots", () => {
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const extra: { desk: string; closed: string; salesThread: string; deskThread: string; finThread: string; room: string; roomThread: string; routine: string; avatar: string } =
      { desk: "", closed: "", salesThread: "", deskThread: "", finThread: "", room: "", roomThread: "", routine: "", avatar: "" };
    const later = () => Date.now() + 86_400_000;
    const invite = async (access: { departments?: Array<{ name: string; level: "view" | "chat" }>; bots?: Array<{ id: string; level: "view" | "chat" }> } | null) => {
      const res = await api("PUT", "/api/department-access", { entry: ADA, admitBots: true, access: access && { departments: access.departments ?? [], bots: access.bots ?? [] } }, BOSS);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res;
    };
    const listed = async (as = ADA) => (await api("GET", "/api/bots?messages=5", undefined, as)).body;
    const botIds = async (as = ADA) => (await listed(as)).bots.map((bot: any) => bot.id).sort();
    const status = async (method: string, path: string, body?: unknown, as = ADA) => (await api(method, path, body, as)).status;
    const capability = async (botId: string, threadId: string) => {
      const minted = await fetch(`${BASE}/api/testing/internal-capability`, {
        method: "POST", headers: { "content-type": "application/json", "x-seira-test-capability": CAPABILITY_KEY },
        body: JSON.stringify({ botId, threadId }),
      });
      return ((await minted.json()) as { token: string }).token;
    };

    beforeAll(async () => {
      for (const [kind, id] of [["bot", ids.sales], ["bot", ids.fin], ["department", "Finance"]]) {
        expect((await api("POST", "/api/paused", { kind, id, paused: false }, BOSS)).status).toBe(200);
      }
      const desk = await makeBot("Desk Heron", "Ops");
      const closed = await makeBot("Vault Crane", "Ops");
      Object.assign(extra, { desk: desk.id, deskThread: desk.threadId, closed: closed.id });
      for (const id of [ids.sales, ids.fin, desk.id, closed.id]) {
        expect((await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "grok", model: "fake-model" } }, BOSS)).status).toBe(200);
      }
      expect((await api("PATCH", `/api/bots/${closed.id}`, { visibility: "admins" }, BOSS)).status).toBe(200);
      const bots = (await listed(BOSS)).bots as Array<{ id: string; threadId: string }>;
      extra.salesThread = bots.find((bot) => bot.id === ids.sales)!.threadId;
      extra.finThread = bots.find((bot) => bot.id === ids.fin)!.threadId;
      const room = await api("POST", "/api/groups", { memberIds: [ids.sales], name: "Sales huddle" }, BOSS);
      expect(room.status, JSON.stringify(room.body)).toBe(201);
      extra.room = room.body.group.id;
      extra.roomThread = room.body.group.threadId;
      const routine = await api("POST", "/api/routines", { name: "Sales sweep", botId: ids.sales, prompt: "Sweep.", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: later() } }, BOSS);
      expect(routine.status, JSON.stringify(routine.body)).toBe(201);
      extra.routine = routine.body.routine.id;
      const upload = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${tokens[BOSS]}` }, body: new Uint8Array(PNG) });
      expect(upload.status).toBe(201);
      extra.avatar = ((await upload.json()) as { path: string }).path.split(/[\\/]/).pop()!;
      expect((await api("PATCH", `/api/bots/${ids.sales}`, { avatarUrl: `/api/attachments/${extra.avatar}` }, BOSS)).status).toBe(200);
    }, 60_000);

    it("shows a member only the chosen bot, in the list and on the stream (AC-04)", async () => {
      await invite({ bots: [{ id: ids.sales, level: "chat" }] });
      expect(await botIds()).toEqual([ids.sales]);
      expect((await listed()).sections).toEqual(["Sales"]);
      const ada = openStream(ADA);
      try {
        expect(await ada.ready()).toBeTruthy();
        const finSend = await api("POST", `/api/bots/${ids.fin}/messages`, { text: "FIN-SECRET-1", threadId: extra.finThread }, BOSS);
        expect(finSend.status, JSON.stringify(finSend.body)).toBe(202);
        const salesSend = await api("POST", `/api/bots/${ids.sales}/messages`, { text: "SALES-OPEN-1", threadId: extra.salesThread }, BOSS);
        expect(salesSend.status, JSON.stringify(salesSend.body)).toBe(202);
        expect(await waitFor(() => ada.frames.some((frame) => frame.kind === "message" && frame.threadId === extra.salesThread))).toBe(true);
        const seen = JSON.stringify(ada.frames);
        for (const hidden of [ids.fin, extra.finThread, "FIN-SECRET-1", "Finance Zebra"]) expect(seen).not.toContain(hidden);
      } finally {
        ada.close();
      }
    }, 60_000);

    it("keeps a bot whose audience refuses the member hidden, until the invite names it (AC-05, AC-06)", async () => {
      await invite({ departments: [{ name: "Ops", level: "chat" }] });
      expect(await botIds()).toEqual([extra.desk]);
      await invite({ bots: [{ id: extra.closed, level: "chat" }] });
      const stored = (await listed(BOSS)).bots.find((bot: any) => bot.id === extra.closed);
      expect(stored.visibility).toEqual({ people: [ADA] });
      expect(await botIds()).toEqual([extra.closed]);
      expect((await api("PATCH", `/api/bots/${extra.closed}`, { visibility: "admins" }, BOSS)).status).toBe(200);
      expect(await botIds()).toEqual([]);
      await invite({ bots: [{ id: extra.closed, level: "chat" }] });
      expect(await botIds()).toEqual([extra.closed]);
      await invite(null);
      expect((await listed(BOSS)).bots.find((bot: any) => bot.id === extra.closed).visibility).toBe("admins");
      expect(await botIds()).not.toContain(extra.closed);
      expect((await api("PATCH", `/api/bots/${extra.closed}`, { visibility: "admins" }, BOSS)).status).toBe(200);
    }, 60_000);

    it("tells a view grant its level and refuses each write with 403 (AC-07, AC-08)", async () => {
      await invite({ bots: [{ id: ids.sales, level: "view" }, { id: extra.desk, level: "chat" }] });
      const bots = (await listed()).bots as any[];
      expect(bots.map((bot) => [bot.id, bot.yourAccess]).sort()).toEqual([[extra.desk, "chat"], [ids.sales, "view"]].sort());
      for (const bot of bots) {
        expect(bot.visibility).toBeUndefined();
        expect(bot.access).toBeUndefined();
        expect(bot.onlyPeopleAdded).toBeUndefined();
      }
      expect(await status("GET", `/api/threads/${extra.salesThread}/messages`)).toBe(200);
      const refused: Array<[string, string, unknown]> = [
        ["POST", `/api/bots/${ids.sales}/messages`, { text: "hello", threadId: extra.salesThread }],
        ["POST", `/api/bots/${ids.sales}/tasks`, { title: "mine" }],
        ["POST", `/api/groups/${extra.room}/messages`, { text: "hello" }],
        ["POST", "/api/routines", { name: "Mine", botId: ids.sales, prompt: "x", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: later() } }],
        ["PATCH", `/api/routines/${extra.routine}`, { enabled: true }],
      ];
      for (const [method, path, body] of refused) {
        const res = await api(method, path, body, ADA);
        expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body.errorKey).toBe("serverError.bot.viewOnly");
      }
      expect(await status("POST", `/api/bots/${extra.desk}/messages`, { text: "hello", threadId: extra.deskThread })).toBe(202);
      expect(await status("POST", `/api/bots/${extra.desk}/tasks`, { title: "mine" })).toBe(201);
    }, 60_000);

    it("answers 404 for a bot, conversation, room, routine and file outside the grant (AC-10)", async () => {
      await invite({ bots: [{ id: extra.desk, level: "chat" }] });
      expect(await status("GET", `/api/attachments/${extra.avatar}`)).toBe(404);
      const outside: Array<[string, string, unknown?]> = [
        ["GET", `/api/threads/${extra.salesThread}/messages`],
        ["POST", `/api/bots/${ids.sales}/messages`, { text: "hello", threadId: extra.salesThread }],
        ["POST", `/api/bots/${ids.sales}/tasks`, { title: "mine" }],
        ["GET", `/api/threads/${extra.roomThread}/messages`],
        ["POST", `/api/groups/${extra.room}/messages`, { text: "hello" }],
        ["PATCH", `/api/routines/${extra.routine}`, { enabled: true }],
        ["POST", "/api/routines", { name: "Mine", botId: ids.sales, prompt: "x", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: later() } }],
        ["GET", `/api/bots/${ids.fin}/slack-management`],
      ];
      for (const [method, path, body] of outside) {
        const res = await api(method, path, body, ADA);
        expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain("forbidden");
      }
      const unknown = await api("GET", "/api/threads/no-such-thread/messages", undefined, ADA);
      const hidden = await api("GET", `/api/threads/${extra.salesThread}/messages`, undefined, ADA);
      expect(hidden.body).toEqual(unknown.body);
      await invite({ bots: [{ id: ids.sales, level: "chat" }] });
      expect(await status("GET", `/api/attachments/${extra.avatar}`)).toBe(200);
    }, 60_000);

    it("closes the member's open stream when the grant changes or goes (AC-12)", async () => {
      await invite({ bots: [{ id: ids.sales, level: "chat" }] });
      for (const change of [{ bots: [{ id: extra.desk, level: "view" as const }] }, null]) {
        const ada = openStream(ADA);
        try {
          expect(await ada.ready()).toBeTruthy();
          await invite(change);
          expect(await waitFor(() => ada.state.ended)).toBe(true);
        } finally {
          ada.close();
        }
        if (change) await invite({ bots: [{ id: ids.sales, level: "chat" }] });
      }
      expect((await botIds()).length).toBeGreaterThan(2);
    }, 60_000);

    it("refuses a hand-off from a bot the member sees to a bot they cannot see (AC-13)", async () => {
      await invite({ bots: [{ id: ids.sales, level: "chat" }, { id: extra.desk, level: "chat" }] });
      const token = await capability(ids.sales, extra.salesThread);
      const ask = (to: string) => fetch(`${BASE}/api/internal/coordinate-bots`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ botIds: [to], message: "Please look at this.", reply: "none" }),
      });
      const refused = await ask(ids.fin);
      const words = await refused.text();
      expect(refused.status, words).toBe(403);
      expect(words).toMatch(/is not shared with everyone who can use/);
      const allowed = await ask(extra.desk);
      expect(allowed.status, await allowed.text()).toBeLessThan(400);
      await invite(null);
      const open = await ask(ids.fin);
      expect(open.status, await open.text()).toBeLessThan(400);
    }, 60_000);

    it("refuses a relayed message for a person who cannot chat with the bot (view), and sends it once they can", async () => {
      const sendFor = async (n: string) => {
        const sent = await api("POST", `/api/bots/${ids.sales}/messages/guarded`, {
          threadId: extra.salesThread, sendId: `relay-access-test-${n}`, text: "Hello from a relay.", expectedActiveLeafId: null, onBehalfOf: { email: ADA, name: "Ada" },
        }, BOSS);
        return sent;
      };
      try {
        await invite({ bots: [{ id: ids.sales, level: "view" }] });
        const refused = await sendFor("view");
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body.error).toContain(`${ADA} can't chat with`);
        await invite({ bots: [{ id: ids.sales, level: "chat" }] });
        const allowed = await sendFor("chat");
        expect(allowed.status, JSON.stringify(allowed.body)).not.toBe(403);
      } finally {
        await invite(null);
      }
    }, 60_000);

    it("removes a deleted bot from the grant and shows the member nothing more (AC-11)", async () => {
      const gone = await makeBot("Short Lived", "Ops");
      await invite({ bots: [{ id: gone.id, level: "chat" }, { id: extra.desk, level: "chat" }] });
      expect(await botIds()).toEqual([extra.desk, gone.id].sort());
      expect((await api("DELETE", `/api/bots/${gone.id}`, undefined, BOSS)).status).toBe(200);
      expect((await api("GET", "/api/department-access", undefined, BOSS)).body.people[ADA].bots).toEqual([{ id: extra.desk, level: "chat" }]);
      expect(await botIds()).toEqual([extra.desk]);
    }, 60_000);

    it("refuses a bot or department that does not exist, and stores nothing (AC-14)", async () => {
      await invite({ bots: [{ id: extra.desk, level: "chat" }] });
      const before = (await api("GET", "/api/department-access", undefined, BOSS)).body;
      for (const access of [{ departments: [], bots: [{ id: "no-such-bot", level: "chat" }] }, { departments: [{ name: "No such place", level: "chat" }], bots: [] }, { departments: [], bots: [] }]) {
        expect((await api("PUT", "/api/department-access", { entry: ADA, access }, BOSS)).status).toBe(400);
      }
      expect((await api("GET", "/api/department-access", undefined, BOSS)).body).toEqual(before);
      await invite(null);
    }, 60_000);
  });
});
