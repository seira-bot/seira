import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  parsePhoneWorkspaceList,
  parsePhoneWorkspaceSwitch,
  phoneWorkspaceSwitchStatusRoute,
  PHONE_WORKSPACE_SWITCH_ROUTE,
  PHONE_WORKSPACES_ROUTE,
  type PhoneWorkspace,
  type PhoneWorkspaceList,
  type PhoneWorkspaceSwitch,
  type PhoneWorkspaceSwitchResponse,
} from "../../packages/phone-protocol/src/workspaces.ts";
import { createProxyHandler, type ProxyListener } from "../src/proxy.ts";
import {
  createWorkspaces,
  WORKSPACE_SWITCH_MESSAGE,
  WORKSPACE_SWITCH_RESULT_MESSAGE,
  WORKSPACE_SWITCH_ROUTE,
  WORKSPACES_MESSAGE,
  WORKSPACES_ROUTE,
  type Workspace,
  type WorkspaceSwitch,
} from "../src/workspaces.ts";

const OPERATION = expect.stringMatching(/^[0-9a-f]{32}$/);
const TOKEN = "seira_test_token";
const OTHER_TOKEN = "seira_other_token";
const PEER_TOKEN = "seira_peer_token";
const ENV_LOCAL = "0b1e6a52-4f7c-4a0e-9d8c-3a5f2b7c9e11";
const ENV_WORK = "7d3f9c14-8a2b-4c5e-b6d7-1e9a0f3c5b28";

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
      if (token === PEER_TOKEN) return { id: "device-3", cloudDesktopAccess: false, browserControlAccess: false, otherWorkspaces: true };
      if (token === OTHER_TOKEN) return { id: "device-2", cloudDesktopAccess: false, browserControlAccess: false, otherWorkspaces: false };
      return null;
    },
    redeem: () => ({ error: "no", code: "pairing_invalid" }) as never,
    serverName: () => "Test computer",
    workspaces: { list: () => workspaces.list(), switchTo: (body, owner) => workspaces.switchTo(body, owner), operation: (id, owner) => workspaces.operation(id, owner), proof: (id, owner, body, context) => workspaces.proof(id, owner, body, context) },
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
    await vi.waitFor(() => expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work", operation: OPERATION }]));
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
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "hurry", id: "work", operation: OPERATION }]);
  });

  it("asks the app to cancel when the phone names the current workspace while a switch waits (AC 6)", async () => {
    facts([{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting", waitingFor: "Scout" }]);
    await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "local" });
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "cancel", id: "local", operation: OPERATION }]);
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
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work", operation: OPERATION }]);
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
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work", operation: OPERATION }]);
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
    expectTypeOf<WorkspaceSwitch>().toEqualTypeOf<PhoneWorkspaceSwitch>();
    expectTypeOf<{ workspaces: Workspace[]; switch?: WorkspaceSwitch }>().toEqualTypeOf<PhoneWorkspaceSwitchResponse>();
    expect(phoneWorkspaceSwitchStatusRoute("abc")).toBe(`${WORKSPACE_SWITCH_ROUTE}/abc`);
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

const FACTS = [
  { id: "local", name: "This PC", environmentId: ENV_LOCAL, current: true, state: "ready" },
  { id: "work", name: "Work", environmentId: ENV_WORK, current: false, state: "ready" },
  { id: "home", name: "Home", current: false, state: "ready" },
];
const statusOf = (id: string, token: string | null = TOKEN) => call("GET", `${WORKSPACE_SWITCH_ROUTE}/${id}`, undefined, token);
const finish = (id: string, outcome: string) => workspaces.receive({ type: WORKSPACE_SWITCH_RESULT_MESSAGE, id, outcome });

describe("the target environment of each workspace", () => {
  it("lists the environmentId that the app knows, and leaves it out when it does not", async () => {
    facts(FACTS);
    const { json } = await call("GET", WORKSPACES_ROUTE);
    expect(json.workspaces.map((workspace: Workspace) => workspace.environmentId)).toEqual([ENV_LOCAL, ENV_WORK, undefined]);
    expect(Object.keys(json.workspaces[2]).sort()).toEqual(["current", "id", "name", "state"]);
  });

  it("drops a value that is not an environment id, whatever the app sent", async () => {
    facts([{ id: "local", current: true, state: "ready", environmentId: "/home/someone/.seira" }, { id: "work", current: false, state: "ready", environmentId: 7 }, { id: "home", current: false, state: "ready", environmentId: ENV_WORK.toUpperCase() }]);
    const { json } = await call("GET", WORKSPACES_ROUTE);
    expect(json.workspaces.map((workspace: Workspace) => workspace.environmentId)).toEqual([undefined, undefined, ENV_WORK]);
  });

  it("is read by the phone protocol, and a bad value reads as absent", () => {
    expect(parsePhoneWorkspaceList({ workspaces: [{ id: "a", environmentId: ENV_WORK, state: "ready" }, { id: "b", environmentId: "nope", state: "ready" }] }).workspaces.map((workspace) => workspace.environmentId)).toEqual([ENV_WORK, undefined]);
  });
});

describe("the operation of a switch", () => {
  it("answers a started switch with its id, the target environment and the state pending, next to the list", async () => {
    facts(FACTS);
    const { status, json } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" });
    expect(status).toBe(200);
    expect(json.workspaces).toHaveLength(3);
    expect(json.switch).toEqual({ id: OPERATION, workspaceId: "work", environmentId: ENV_WORK, state: "pending" });
    expect(Object.keys(json.switch).sort()).toEqual(["environmentId", "id", "state", "workspaceId"]);
    expect(sent).toEqual([{ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work", operation: json.switch.id }]);
  });

  it("leaves the environment out for a target that has none, and gives each switch its own id", async () => {
    facts(FACTS);
    const first = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "home" })).json.switch;
    const second = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "home" })).json.switch;
    expect(first.environmentId).toBeUndefined();
    expect(first.id).not.toBe(second.id);
  });

  it("answers the list alone when nothing starts, as before", async () => {
    facts(FACTS);
    const { json } = await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "local" });
    expect(Object.keys(json)).toEqual(["workspaces"]);
  });

  it("lets the phone read when the switch is complete, by id (done)", async () => {
    facts(FACTS);
    const { id } = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
    expect((await statusOf(id)).json).toEqual({ switch: { id, workspaceId: "work", environmentId: ENV_WORK, state: "pending" } });
    finish(id, "done");
    expect((await statusOf(id)).json.switch.state).toBe("done");
    finish(id, "failed");
    expect((await statusOf(id)).json.switch.state, "an ended switch does not change").toBe("done");
  });

  it("reads a failed switch as failed", async () => {
    facts(FACTS);
    const { id } = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
    finish(id, "failed");
    expect((await statusOf(id)).json.switch.state).toBe("failed");
  });

  it("ignores a result with an unknown id or an unknown outcome", async () => {
    facts(FACTS);
    const { id } = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
    expect(finish("f".repeat(32), "done")).toBe(true);
    expect(finish(id, "exploded")).toBe(true);
    expect(workspaces.receive({ type: WORKSPACE_SWITCH_RESULT_MESSAGE, id: 7, outcome: "done" })).toBe(true);
    expect((await statusOf(id)).json.switch.state).toBe("pending");
  });

  it("changes only the switch that a result names, to the outcome it names", async () => {
    facts(FACTS);
    const first = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
    facts([FACTS[0], { ...FACTS[1], state: "waiting", waitingFor: "Scout" }, FACTS[2]]);
    const hurry = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work", now: true })).json.switch;
    const cancel = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "local" })).json.switch;
    finish(hurry.id, "done");
    expect((await statusOf(first.id)).json.switch.state, "a hurry result does not reach an earlier switch").toBe("pending");
    expect((await statusOf(cancel.id)).json.switch.state, "nor a later one").toBe("pending");
    finish(cancel.id, "failed");
    finish(first.id, "superseded");
    expect((await statusOf(first.id)).json.switch.state, "a later cancel that failed is not the cause").toBe("superseded");
    expect((await statusOf(hurry.id)).json.switch.state).toBe("done");
    expect((await statusOf(cancel.id)).json.switch.state).toBe("failed");
  });

  it("reads each outcome that the app names: done, failed, superseded and cancelled", async () => {
    facts(FACTS);
    const ids: string[] = [];
    for (const outcome of ["done", "failed", "superseded", "cancelled"]) {
      const { id } = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
      finish(id, outcome);
      ids.push(id);
    }
    expect(await Promise.all(ids.map(async (id) => (await statusOf(id)).json.switch.state))).toEqual(["done", "failed", "superseded", "cancelled"]);
  });

  it("does not let another phone's result end the switch of this phone", async () => {
    facts(FACTS);
    const older = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" }, TOKEN)).json.switch;
    const newer = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "home" }, PEER_TOKEN)).json.switch;
    finish(newer.id, "superseded");
    expect((await statusOf(older.id)).json.switch.state).toBe("pending");
  });

  it("answers 404 switch_not_found for an unknown id, an id that cannot be one, and another phone's switch", async () => {
    facts(FACTS);
    const { id } = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
    for (const wrong of ["f".repeat(32), "short", "%zz", "..%2f..%2fetc", "A".repeat(32), "x".repeat(300)]) {
      const reply = await statusOf(wrong);
      expect([reply.status, reply.json], wrong).toEqual([404, { error: "switch_not_found" }]);
    }
    const foreign = await statusOf(id, PEER_TOKEN);
    expect([foreign.status, foreign.json]).toEqual([404, { error: "switch_not_found" }]);
    expect((await statusOf(id)).status).toBe(200);
    expect(JSON.stringify(foreign.json)).not.toContain(id);
  });

  it("refuses the read route to a phone that may not open other workspaces, an unpaired phone, and before the app sent facts", async () => {
    expect((await statusOf("f".repeat(32))).status, "no facts yet").toBe(404);
    facts(FACTS);
    const { id } = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
    expect((await statusOf(id, OTHER_TOKEN)).status).toBe(403);
    expect((await statusOf(id, null)).status).toBe(401);
    otherWorkspaces = false;
    expect((await statusOf(id)).status, "turned off after the switch started").toBe(403);
    otherWorkspaces = true;
    paired = false;
    expect((await statusOf(id)).status).toBe(401);
    paired = true;
    facts(null);
    expect((await statusOf(id)).status, "home is not this computer").toBe(404);
  });

  it("answers itself, never asks the server, and takes no other path below the route", async () => {
    facts(FACTS);
    const { id } = (await call("POST", WORKSPACE_SWITCH_ROUTE, { id: "work" })).json.switch;
    for (const way of ["lan", "origin"] as const) {
      listener = way;
      expect((await statusOf(id)).status).toBe(200);
    }
    expect((await call("GET", `${WORKSPACE_SWITCH_ROUTE}/${id}/more`)).status).toBe(404);
    expect((await call("POST", `${WORKSPACE_SWITCH_ROUTE}/${id}`, {})).status).toBe(404);
    expect(harnessHits).toEqual([]);
  });

  it("never holds more than 50 switches, not even right after an insert and before any read", async () => {
    let counter = 0;
    // The history is private, so a spy on Map.set finds it. A read prunes too, so only its size right after a switch counts.
    const maps = new Set<Map<unknown, unknown>>();
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === "string" && /^[0-9a-f]{32}$/.test(key)) maps.add(this);
      return set.call(this, key, value);
    });
    try {
      const channel = createWorkspaces({ send: () => {}, settleMs: 1, now: () => 1_000_000, newId: () => (++counter).toString(16).padStart(32, "0") });
      channel.receive({ type: WORKSPACES_MESSAGE, workspaces: FACTS });
      for (let index = 0; index < 53; index++) {
        await channel.switchTo({ id: "work" }, "device-1");
        for (const map of maps) expect(map.size, `after switch ${index + 1}`).toBeLessThanOrEqual(50);
      }
      expect(maps.size).toBeGreaterThan(0);
      expect(channel.operation("00000000000000000000000000000035", "device-1").status).toBe(200);
      expect(channel.operation("00000000000000000000000000000003", "device-1").status).toBe(404);
      expect(channel.operation("00000000000000000000000000000004", "device-1").status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a switch for 30 minutes, then forgets it, and keeps the last 50", () => {
    let time = 1_000_000;
    let counter = 0;
    const channel = createWorkspaces({ send: () => {}, settleMs: 1, now: () => time, newId: () => (++counter).toString(16).padStart(32, "0") });
    channel.receive({ type: WORKSPACES_MESSAGE, workspaces: FACTS });
    return (async () => {
      const first = (await channel.switchTo({ id: "work" }, "device-1")).body as { switch: WorkspaceSwitch };
      expect(channel.operation(first.switch.id, "device-1").status).toBe(200);
      time += 30 * 60_000;
      expect(channel.operation(first.switch.id, "device-1").status, "30 minutes exactly is still kept").toBe(200);
      time += 1;
      expect(channel.operation(first.switch.id, "device-1").status).toBe(404);
      const ids: string[] = [];
      for (let index = 0; index < 52; index++) ids.push(((await channel.switchTo({ id: "work" }, "device-1")).body as { switch: WorkspaceSwitch }).switch.id);
      expect(channel.operation(ids[0], "device-1").status).toBe(404);
      expect(channel.operation(ids[1], "device-1").status).toBe(404);
      expect(channel.operation(ids[2], "device-1").status).toBe(200);
      expect(channel.operation(ids[51], "device-1").status).toBe(200);
    })();
  });
});

describe("the phone protocol reads a switch", () => {
  it("reads the switch of a response and of the read route, and a state it does not know as pending", () => {
    expect(parsePhoneWorkspaceSwitch({ id: "a", workspaceId: "work", environmentId: ENV_WORK, state: "done" })).toEqual({ id: "a", workspaceId: "work", environmentId: ENV_WORK, state: "done" });
    expect(parsePhoneWorkspaceSwitch({ id: "a", workspaceId: "work", state: "teleporting" })).toEqual({ id: "a", workspaceId: "work", state: "pending" });
    expect(parsePhoneWorkspaceSwitch({ id: "a", workspaceId: "work", environmentId: "/etc", state: "failed" })).toEqual({ id: "a", workspaceId: "work", state: "failed" });
    for (const bad of [null, "x", {}, { id: "a" }, { workspaceId: "w" }]) expect(parsePhoneWorkspaceSwitch(bad)).toBeNull();
  });
});
