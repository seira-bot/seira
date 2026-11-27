import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VisibleSet } from "../bot-visibility.ts";
import { createTodosHost, TodoError, type TodoBot, type TodoRoutines } from "../host/todos-host.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { TodoStore } from "../todos.ts";
import { createTodoRoutes } from "./todos.ts";
import { PASS, type RouteContext } from "./table.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const BOTS: TodoBot[] = [{ id: "atlas", name: "Atlas" }, { id: "scout", name: "Scout" }];

function setup(options: { hiddenThreads?: string[]; hiddenBots?: string[]; level?: string; routine?: TodoRoutines; routineRefusal?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "todo-routes-"));
  dirs.push(dir);
  let n = 0;
  const store = new TodoStore({ dataDir: dir, newId: () => `t${++n}` });
  const gated: unknown[] = [];
  const routines: TodoRoutines = options.routine ?? { create: () => ({ id: "r1" }), remove: () => true, update: () => null };
  const host = createTodosHost({ store, bots: () => BOTS, routines: () => routines, teamCloud: false });
  const visible = {
    everything: false,
    thread: (id: string) => !(options.hiddenThreads ?? []).includes(id),
    bot: (id: string) => !(options.hiddenBots ?? []).includes(id),
    level: () => options.level ?? "chat",
  } as unknown as VisibleSet;
  const route = createTodoRoutes({
    store, host, runner: { startNow: async (id) => store.get(id)!, wake: () => {} }, visibleFor: () => visible, personName: () => "Rama",
    routineRefusal: () => options.routineRefusal ?? null,
    withPerson: (auth, work) => { gated.push(auth.kind); return work(); },
  });
  const call = async (method: string, path: string, body: unknown = {}) => {
    const sent: { status?: number; body?: any } = {};
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method,
      auth: { kind: "loopback", scopes: ["client"] } as RequestAuth, readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, payload: unknown) => { sent.status = status; sent.body = payload; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { call, store, gated };
}

describe("todo routes", () => {
  it("refuses to change or delete a todo whose repeating job the person may not edit (security)", async () => {
    const { call, store } = setup({ routineRefusal: "Only people who can edit Atlas can change this." });
    const added = await call("POST", "/api/todos", { todos: [{ title: "Digest", botId: "atlas", repeat: { time: "09:00", weekdays: [] } }] });
    const id = added.body.todos[0].id;
    for (const [method, body] of [["PATCH", { title: "Other" }], ["DELETE", {}]] as const) {
      const refused = await call(method, `/api/todos/${id}`, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("Only people who can edit");
    }
    expect(store.get(id)!.title).toBe("Digest");
    expect(store.live()).toHaveLength(1);
  });

  it("passes other paths on", async () => expect((await setup().call("GET", "/api/board")).out).toBe(PASS));

  it("adds, lists, patches, deletes and restores a todo (AC-02)", async () => {
    const { call } = setup();
    const added = await call("POST", "/api/todos", { todos: [{ title: "Write notes", botId: "atlas" }] });
    expect(added.status).toBe(200);
    const id = added.body.todos[0].id;
    expect((await call("GET", "/api/todos")).body.todos).toHaveLength(1);
    expect((await call("PATCH", `/api/todos/${id}`, { title: "Better" })).body.todo.title).toBe("Better");
    expect((await call("DELETE", `/api/todos/${id}`)).status).toBe(200);
    expect((await call("GET", "/api/todos")).body.todos).toHaveLength(0);
    expect((await call("POST", `/api/todos/${id}/restore`)).body.todo.id).toBe(id);
  });

  it("makes the routine of a repeating todo inside the person's context (gate parity)", async () => {
    const { call, gated } = setup();
    await call("POST", "/api/todos", { todos: [{ title: "Digest", botId: "atlas", repeat: { time: "09:00", weekdays: [] } }] });
    expect(gated).toEqual(["loopback"]);
  });

  it("refuses the todo with the routine check's own reason (gate parity)", async () => {
    const routine: TodoRoutines = { create: () => { throw new TodoError(403, "Not for you."); }, remove: () => true, update: () => null };
    const { call, store } = setup({ routine });
    const refused = await call("POST", "/api/todos", { todos: [{ title: "Digest", botId: "atlas", repeat: { time: "09:00", weekdays: [] } }] });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Not for you.");
    expect(store.live()).toEqual([]);
  });

  it("gives a todo whose conversation or bot the viewer cannot see a 404 (AC-14)", async () => {
    const { call, store } = setup({ hiddenThreads: ["secret"] });
    store.insert({ id: "s", title: "Hidden", status: "open", start: { kind: "free" }, rank: 1, madeBy: { kind: "person", name: "R" }, source: { threadId: "secret", quote: "q" }, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1 });
    expect((await call("GET", "/api/todos")).body.todos).toEqual([]);
    expect((await call("PATCH", "/api/todos/s", { title: "x" })).status).toBe(404);
    expect((await call("DELETE", "/api/todos/s")).status).toBe(404);
  });

  it("needs chat level to give a bot work, and refuses a source the viewer cannot see", async () => {
    expect((await setup({ level: "view" }).call("POST", "/api/todos", { todos: [{ title: "x", botId: "atlas" }] })).status).toBe(403);
    expect((await setup({ hiddenThreads: ["secret"] }).call("POST", "/api/todos", { todos: [{ title: "x", source: { threadId: "secret", quote: "q" } }] })).status).toBe(400);
  });

  it("keeps the picker choice and asks for scopes", async () => {
    const { call } = setup();
    expect((await call("PUT", "/api/todos/picker", { botId: "scout" })).body.picker).toBe("scout");
    expect(requiredScope("GET", "/api/todos")).toBe("client");
    expect(requiredScope("PUT", "/api/todos/picker")).toBe("admin");
  });
});
