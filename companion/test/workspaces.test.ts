import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  parsePhoneWorkspaceList,
  PHONE_WORKSPACE_SWITCH_ROUTE,
  PHONE_WORKSPACES_ROUTE,
  type PhoneWorkspace,
  type PhoneWorkspaceList,
} from "../../packages/phone-protocol/src/workspaces.ts";
import { createProxyHandler, type ProxyListener } from "../src/proxy.ts";
import {
  createWorkspaces,
  WORKSPACE_SWITCH_MESSAGE,
  WORKSPACE_SWITCH_ROUTE,
  WORKSPACES_MESSAGE,
  WORKSPACES_ROUTE,
  type Workspace,
} from "../src/workspaces.ts";

const TOKEN = "seira_test_token";
const OTHER_TOKEN = "seira_other_token";

const LIST = [
  { id: "local", name: "This PC", current: true, state: "ready" },
  { id: "work", name: "Work", color: "#16a34a", current: false, state: "ready" },
  { id: "home", name: "Home", current: false, state: "ready" },
];

let harness: Server;
let sidecar: Server;
let harnessHits: string[] = [];
let sent: Array<Record<string, unknown>> = [];
let listener: ProxyListener = "lan";
let workspaces = createWorkspaces({ send: () => {}, settleMs: 5 });
let otherWorkspaces: boolean | undefined = true;
let paired = true;

const facts = (list: unknown) => workspaces.receive({ type: WORKSPACES_MESSAGE, workspaces: list });

beforeAll(async () => {
  harness = createServer((req, res) => {
    harnessHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const proxy = createProxyHandler({
    harnessPort: (harness.address() as AddressInfo).port,
    authenticate: (token) => {
      if (token === TOKEN) return !paired ? null : { id: "device-1", cloudDesktopAccess: false, browserControlAccess: false, otherWorkspaces };
      if (token === OTHER_TOKEN) return { id: "device-2", cloudDesktopAccess: false, browserControlAccess: false, otherWorkspaces: false };
      return null;
    },
    redeem: () => ({ error: "no", code: "pairing_invalid" }) as never,
    serverName: () => "Test computer",
    workspaces: { list: () => workspaces.list(), switchTo: (body) => workspaces.switchTo(body) },
  });
  sidecar = createServer((req, res) => proxy(req, res, listener));
  await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  sidecar.closeAllConnections();
  await Promise.all([sidecar, harness].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

beforeEach(() => {
  harnessHits = [];
  sent = [];
  listener = "lan";
  otherWorkspaces = true;
  paired = true;
  workspaces = createWorkspaces({ send: (message) => sent.push(message as Record<string, unknown>), settleMs: 5 });
});

function call(method: string, path: string, body?: unknown, token: string | null = TOKEN, raw = false): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : raw ? String(body) : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: (sidecar.address() as AddressInfo).port,
        path,
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { "content-type": "application/json" } : {}) },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Sends the headers of a switch request, runs `whileWaiting` while the sidecar waits for the body, then sends the body. */
function callWhileBodyWaits(body: unknown, whileWaiting: () => void): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: (sidecar.address() as AddressInfo).port,
        path: WORKSPACE_SWITCH_ROUTE,
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => {
      whileWaiting();
      req.end(JSON.stringify(body));
    }, 50);
  });
}

describe("the phone's workspace list", () => {
  it("lists This PC and each workspace of the desktop, with exactly one current (AC 1)", async () => {
    facts(LIST);
    const { status, json } = await call("GET", WORKSPACES_ROUTE);
    expect(status).toBe(200);
    expect(json.workspaces.map((workspace: Workspace) => workspace.id)).toEqual(["local", "work", "home"]);
    expect(json.workspaces.filter((workspace: Workspace) => workspace.current)).toHaveLength(1);
  });

  it("keeps one current workspace even when the app sent two", async () => {
    facts([{ id: "a", current: true, state: "ready" }, { id: "b", current: true, state: "ready" }]);
    const { json } = await call("GET", WORKSPACES_ROUTE);
    expect(json.workspaces.map((workspace: Workspace) => workspace.current)).toEqual([true, false]);
  });

  it("holds no folder path, address or port, whatever the app sent (AC 2)", async () => {
    facts([{ id: "local", name: "This PC", current: true, state: "ready", dir: "/home/someone/.seira", path: "C:\\Users\\x", port: 8799, origin: "http://10.0.0.5:8799" }]);
    const { json } = await call("GET", WORKSPACES_ROUTE);
    expect(Object.keys(json.workspaces[0]).sort()).toEqual(["current", "id", "name", "state"]);
    expect(JSON.stringify(json)).not.toMatch(/\/home|C:|8799|10\.0\.0\.5/);
  });

  it("marks the waiting workspace with the bot's name (AC 4)", async () => {
    facts([{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting", waitingFor: "Scout" }]);
    const { json } = await call("GET", WORKSPACES_ROUTE);
    expect(json.workspaces[1]).toEqual({ id: "work", current: false, state: "waiting", waitingFor: "Scout" });
  });

  it("lists the new current workspace after the app sends new facts (AC 10)", async () => {
    facts(LIST);
    facts(LIST.map((workspace) => ({ ...workspace, current: workspace.id === "work" })));
    const { json } = await call("GET", WORKSPACES_ROUTE);
    expect(json.workspaces.find((workspace: Workspace) => workspace.current).id).toBe("work");
  });

  it("answers 404 on both routes while the app has sent no facts or home is not this computer (AC 8)", async () => {
    expect((await call("GET", WORKSPACES_ROUTE)).status).toBe(404);
    expect((await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).status).toBe(404);
    facts(LIST);
    facts(null);
    expect((await call("GET", WORKSPACES_ROUTE)).status).toBe(404);
    expect((await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("answers itself on the way in through the Wi-Fi port and the private origin, and never asks the server (AC 9)", async () => {
    facts(LIST);
    for (const way of ["lan", "origin"] as const) {
      listener = way;
      expect((await call("GET", WORKSPACES_ROUTE)).status).toBe(200);
      expect((await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "local" })).status).toBe(200);
    }
    facts(null);
    await call("GET", WORKSPACES_ROUTE);
    await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(harnessHits).toEqual([]);
  });

  it("refuses a device that is not paired", async () => {
    facts(LIST);
    expect((await call("GET", WORKSPACES_ROUTE, undefined, null)).status).toBe(401);
    expect((await call("GET", WORKSPACES_ROUTE, undefined, "wrong")).status).toBe(401);
  });

  it("refuses other methods on the two routes", async () => {
    facts(LIST);
    expect((await call("POST", WORKSPACES_ROUTE, {})).status).toBe(404);
    expect((await call("GET", WORKSPACE_SWITCH_ROUTE)).status).toBe(404);
    expect(harnessHits).toEqual([]);
  });
});

describe("a request to switch", () => {
  it("asks the app to open a ready workspace, and answers with the list the app sends next (AC 3, 4)", async () => {
    workspaces = createWorkspaces({ send: (message) => sent.push(message as Record<string, unknown>), settleMs: 10_000 });
    facts(LIST);
    const pending = call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    await vi.waitFor(() => expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work" }]));
    facts([{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting", waitingFor: "Scout" }, { id: "home", current: false, state: "unavailable" }]);
    const { status, json } = await pending;
    expect(status).toBe(200);
    expect(json.workspaces[1].state).toBe("waiting");
  });

  it("answers with the list as it is when the app does not answer in time", async () => {
    facts(LIST);
    const { status, json } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(status).toBe(200);
    expect(json.workspaces).toHaveLength(3);
  });

  it("asks the app to open the waiting workspace now only with now: true (AC 5)", async () => {
    facts([{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting", waitingFor: "Scout" }]);
    await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(sent).toEqual([]);
    await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work", now: true });
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "hurry", id: "work" }]);
  });

  it("asks the app to cancel when the phone names the current workspace while a switch waits (AC 6)", async () => {
    facts([{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting", waitingFor: "Scout" }]);
    await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "local" });
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "cancel", id: "local" }]);
  });

  it("does nothing for the current workspace when no switch waits", async () => {
    facts(LIST);
    const { status } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "local" });
    expect(status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("answers 404 workspace_not_found for an id that is not in the list, and starts no switch (AC 7)", async () => {
    facts(LIST);
    for (const id of ["nope", "../../etc", "", 7, null]) {
      const { status, json } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id });
      expect(status).toBe(404);
      expect(json).toEqual({ error: "workspace_not_found" });
    }
    expect((await call("POST", WORKSPACE_SWITCH_ROUTE, {})).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("refuses a workspace that is not available, and starts no switch", async () => {
    facts([{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "unavailable" }]);
    const { status, json } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(status).toBe(409);
    expect(json).toEqual({ error: "workspace_unavailable" });
    expect(sent).toEqual([]);
  });

  it("refuses a body that is not JSON", async () => {
    facts(LIST);
    const reply = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: (sidecar.address() as AddressInfo).port, path: WORKSPACE_SWITCH_ROUTE, method: "POST", headers: { authorization: `Bearer ${TOKEN}` } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end("{not json");
    });
    expect(reply).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("a phone that may not open other workspaces", () => {
  it("is the default: a device with no such setting lists one workspace and cannot switch", async () => {
    facts(LIST);
    otherWorkspaces = undefined;
    expect((await call("GET", WORKSPACES_ROUTE)).json.workspaces).toHaveLength(1);
    expect((await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("lists every workspace and switches for a device the owner allowed", async () => {
    facts(LIST);
    otherWorkspaces = true;
    expect((await call("GET", WORKSPACES_ROUTE)).json.workspaces).toHaveLength(3);
    expect((await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("answers one device with 403 and another with a switch, on the same computer at the same time", async () => {
    facts(LIST);
    otherWorkspaces = true;
    const refused = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" }, OTHER_TOKEN);
    expect(refused.status).toBe(403);
    expect(sent).toEqual([]);
    const allowed = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(allowed.status).toBe(200);
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work" }]);
    expect((await call("GET", WORKSPACES_ROUTE, undefined, OTHER_TOKEN)).json.workspaces).toHaveLength(1);
    expect((await call("GET", WORKSPACES_ROUTE)).json.workspaces).toHaveLength(3);
  });

  it("is refused before the body is read, so a body that cannot be read is still 403", async () => {
    facts(LIST);
    otherWorkspaces = false;
    const { status } = await call("POST", WORKSPACE_SWITCH_ROUTE, "{ not json", TOKEN, true);
    expect(status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("refuses a switch when the owner turns the phone off while the body is still being read", async () => {
    facts(LIST);
    otherWorkspaces = true;
    const { status, json } = await callWhileBodyWaits({ id: "work" }, () => {
      otherWorkspaces = false;
    });
    expect(status).toBe(403);
    expect(json.error).toMatch(/cannot open other workspaces/);
    expect(sent).toEqual([]);
    expect(workspaces.list()?.filter((workspace) => workspace.current).map((workspace) => workspace.id)).toEqual(["local"]);
  });

  it("refuses a switch when the phone is unpaired while the body is still being read", async () => {
    facts(LIST);
    const { status } = await callWhileBodyWaits({ id: "work" }, () => {
      paired = false;
    });
    expect(status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("answers 403 without the list when the owner turns the phone off while the desktop's answer is awaited", async () => {
    facts(LIST);
    otherWorkspaces = true;
    workspaces = createWorkspaces({
      send: (message) => {
        sent.push(message as Record<string, unknown>);
        otherWorkspaces = false;
        setTimeout(() => facts([{ id: "local", name: "This PC", current: false, state: "ready" }, { id: "work", name: "Work", current: true, state: "ready" }]), 1);
      },
      settleMs: 50,
    });
    facts(LIST);
    const { status, json } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(status).toBe(403);
    expect(json.workspaces).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/Work|home/);
  });

  it("answers 403 without the list when the phone is unpaired while the desktop's answer is awaited", async () => {
    workspaces = createWorkspaces({
      send: (message) => {
        sent.push(message as Record<string, unknown>);
        paired = false;
      },
      settleMs: 20,
    });
    facts(LIST);
    const { status, json } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(status).toBe(403);
    expect(json.workspaces).toBeUndefined();
  });

  it("still switches when the phone keeps its access while the body is read", async () => {
    facts(LIST);
    const { status } = await callWhileBodyWaits({ id: "work" }, () => {});
    expect(status).toBe(200);
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work" }]);
  });

  it("lists the current workspace only, on the next request after the owner turns the phone off", async () => {
    facts(LIST);
    expect((await call("GET", WORKSPACES_ROUTE)).json.workspaces).toHaveLength(3);
    otherWorkspaces = false;
    const { status, json } = await call("GET", WORKSPACES_ROUTE);
    expect(status).toBe(200);
    expect(json.workspaces.map((workspace: Workspace) => workspace.id)).toEqual(["local"]);
  });

  it("lists only the current workspace", async () => {
    facts(LIST);
    otherWorkspaces = false;
    const { status, json } = await call("GET", WORKSPACES_ROUTE);
    expect(status).toBe(200);
    expect(json.workspaces).toEqual([{ id: "local", name: "This PC", current: true, state: "ready" }]);
  });

  it("refuses every switch with 403 and sends nothing to the app", async () => {
    facts([{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting", waitingFor: "Scout" }, { id: "home", current: false, state: "ready" }]);
    otherWorkspaces = false;
    for (const body of [{ id: "home" }, { id: "work", now: true }, { id: "local" }]) {
      const { status, json } = await call("POST", WORKSPACE_SWITCH_ROUTE, body);
      expect(status).toBe(403);
      expect(json.error).toMatch(/cannot open other workspaces/);
      expect(json.error).not.toMatch(/\/api|workspace_|403/);
    }
    expect(sent).toEqual([]);
  });

  it("still answers 404 on both routes while the app has sent no facts", async () => {
    otherWorkspaces = false;
    expect((await call("GET", WORKSPACES_ROUTE)).status).toBe(404);
    expect((await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).status).toBe(404);
  });

  it("cannot change its own access through any phone route", async () => {
    facts(LIST);
    for (const [method, path] of [["POST", "/devices/device-1/other-workspaces"], ["DELETE", "/devices/device-1/other-workspaces"], ["PUT", "/api/phones/self/workspaces/access"], ["POST", "/api/phones/self/workspaces/access"]]) {
      const { status } = await call(method, path, { allowed: true });
      expect([403, 404], `${method} ${path}`).toContain(status);
    }
    expect(harnessHits).toEqual([]);
  });
});

describe("the contract", () => {
  it("is the same in the phone protocol and in the companion", () => {
    expect(WORKSPACES_ROUTE).toBe(PHONE_WORKSPACES_ROUTE);
    expect(WORKSPACE_SWITCH_ROUTE).toBe(PHONE_WORKSPACE_SWITCH_ROUTE);
    expectTypeOf<Workspace>().toEqualTypeOf<PhoneWorkspace>();
    expectTypeOf<{ workspaces: Workspace[] }>().toEqualTypeOf<PhoneWorkspaceList>();
  });

  it("reads a state it does not know as unavailable, and drops what has no id", () => {
    const list = parsePhoneWorkspaceList({
      workspaces: [
        { id: "a", current: true, state: "ready" },
        { id: "b", state: "paused", waitingFor: "Scout" },
        { id: "a", state: "ready" },
        { name: "no id", state: "ready" },
        "junk",
      ],
    });
    expect(list.workspaces).toEqual([
      { id: "a", current: true, state: "ready" },
      { id: "b", current: false, state: "unavailable" },
    ]);
    expect(parsePhoneWorkspaceList(null)).toEqual({ workspaces: [] });
    expect(parsePhoneWorkspaceList({ workspaces: "x" })).toEqual({ workspaces: [] });
  });

  it("parses what the companion answers", async () => {
    facts(LIST);
    const { json } = await call("GET", WORKSPACES_ROUTE);
    expect(parsePhoneWorkspaceList(json).workspaces).toEqual(json.workspaces);
  });
});
