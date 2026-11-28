import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Audience } from "../audience.ts";
import type { ThreadOwner, VisibleSet } from "../bot-visibility.ts";
import { createTodosHost, TodoError, type TodoBot, type TodoRoutines } from "../host/todos-host.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { TodoStore, type TodoRecord } from "../todos.ts";
import { createTodoRoutes } from "./todos.ts";
import { PASS, type RouteContext } from "./table.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const BOTS: TodoBot[] = [{ id: "atlas", name: "Atlas" }, { id: "scout", name: "Scout" }];

function setup(options: { hiddenThreads?: string[]; hiddenBots?: string[]; hiddenGroups?: string[]; levels?: Record<string, string>; level?: string; routine?: TodoRoutines; routineRefusal?: string; audiences?: Record<string, Audience>; shown?: string[]; owners?: Record<string, ThreadOwner>; changeRefusal?: (todo: TodoRecord) => string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "todo-routes-"));
  dirs.push(dir);
  let n = 0;
  const store = new TodoStore({ dataDir: dir, newId: () => `t${++n}` });
  const gated: unknown[] = [];
  const routines: TodoRoutines = options.routine ?? { create: () => ({ id: "r1" }), remove: () => true, update: () => null };
  const host = createTodosHost({ store, bots: () => BOTS, routines: () => routines, teamCloud: false, levelFor: () => "chat", audienceOf: (threadId) => options.audiences?.[threadId] ?? "team" });
  const visible = {
    everything: false,
    thread: (id: string) => !(options.hiddenThreads ?? []).includes(id),
    bot: (id: string) => !(options.hiddenBots ?? []).includes(id),
    group: (id: string) => !(options.hiddenGroups ?? []).includes(id),
    level: (id: string) => options.levels?.[id] ?? options.level ?? "chat",
    shows: (audience: string) => audience === "team" || (options.shown ?? []).includes(audience),
  } as unknown as VisibleSet;
  const started: string[] = [];
  const route = createTodoRoutes({
    store, host, runner: { startNow: async (id) => { started.push(id); return store.get(id)!; }, wake: () => {} }, visibleFor: () => visible, threadOwner: (id) => options.owners?.[id], personName: () => "Rama",
    todoPerson: () => ({ key: "p_rama", viewer: { kind: "member", email: "rama@example.com" } }),
    changeRefusal: (_auth, todo) => options.changeRefusal?.(todo) ?? null,
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
  return { call, store, gated, started };
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

  it("records whom a todo works for and never sends it to a client (security)", async () => {
    const { call, store } = setup();
    const added = await call("POST", "/api/todos", { todos: [{ title: "Write notes", botId: "atlas" }] });
    expect(added.body.todos[0].person).toBeUndefined();
    expect(store.get(added.body.todos[0].id)!.person).toEqual({ key: "p_rama", viewer: { kind: "member", email: "rama@example.com" } });
    expect((await call("GET", "/api/todos")).body.todos[0].person).toBeUndefined();
  });

  it("refuses to change, start, delete or restore a todo someone else made where the send rule says so (security)", async () => {
    const { call, store, started } = setup({ changeRefusal: (todo) => (todo.person?.key === "p_owner" ? "On this Cloud you can only change todos you made." : null) });
    store.insert({ id: "o", title: "Owner's", status: "queued", botId: "atlas", start: { kind: "free" }, rank: 1, madeBy: { kind: "person", name: "Owner" }, person: { key: "p_owner" }, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1 });
    for (const [method, path, body] of [["PATCH", "/api/todos/o", { note: "Also email the files" }], ["PATCH", "/api/todos/o", { botId: "scout" }], ["POST", "/api/todos/o/start", {}], ["DELETE", "/api/todos/o", {}]] as const) {
      const refused = await call(method, path, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("only change todos you made");
    }
    expect(started).toEqual([]);
    expect(store.get("o")).toMatchObject({ title: "Owner's", botId: "atlas" });
    expect(store.get("o")!.note).toBeUndefined();
    store.remove("o");
    expect((await call("POST", "/api/todos/o/restore")).status).toBe(403);
    expect(store.get("o")).toBeUndefined();
  });

  it("keeps the picker choice and asks for scopes", async () => {
    const { call } = setup();
    expect((await call("PUT", "/api/todos/picker", { botId: "scout" })).body.picker).toBe("scout");
    expect(requiredScope("GET", "/api/todos")).toBe("client");
    expect(requiredScope("PUT", "/api/todos/picker")).toBe("admin");
  });

  const base = { status: "open" as const, start: { kind: "free" as const }, rank: 1, madeBy: { kind: "person" as const, name: "R" }, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1 };

  it("hides a todo whose work conversation the viewer cannot see, from the list and from every change (security)", async () => {
    const { call, store } = setup({ hiddenThreads: ["work-private"] });
    store.insert({ ...base, id: "w", title: "Done work", botId: "atlas", status: "done", result: "Private reply", threadId: "work-private", finishedAt: Date.now(), updatedAt: Date.now() });
    expect(JSON.stringify((await call("GET", "/api/todos")).body)).not.toContain("Private reply");
    expect((await call("PATCH", "/api/todos/w", { title: "x" })).status).toBe(404);
    expect((await call("DELETE", "/api/todos/w")).status).toBe(404);
    expect((await call("POST", "/api/todos/w/start")).status).toBe(404);
  });

  it("needs chat level on the source bot to change a todo that has no bot yet (security)", async () => {
    const { call, store } = setup({ levels: { atlas: "view" } });
    store.insert({ ...base, id: "o", title: "Open", source: { threadId: "chat1", botId: "atlas" } });
    expect((await call("PATCH", "/api/todos/o", { title: "x" })).status).toBe(403);
    expect((await call("DELETE", "/api/todos/o")).status).toBe(403);
    expect((await call("POST", "/api/todos/o/start")).status).toBe(403);
    expect(store.get("o")!.title).toBe("Open");
  });

  it("refuses a restore of a todo the viewer may not change (security)", async () => {
    const { call, store } = setup({ levels: { atlas: "view" } });
    store.insert({ ...base, id: "o", title: "Open", source: { threadId: "chat1", botId: "atlas" } });
    store.remove("o");
    expect((await call("POST", "/api/todos/o/restore")).status).toBe(404);
    expect(store.get("o")).toBeUndefined();
  });

  it("takes the bot and the room of a source from the server, not from the client (security)", async () => {
    const draft = (source: unknown) => ({ todos: [{ title: "x", source }] });
    const owners = { c: { bot: "atlas" }, g1: { group: "g" } };
    expect((await setup({ owners, levels: { atlas: "view" } }).call("POST", "/api/todos", draft({ threadId: "c" }))).status).toBe(403);
    expect((await setup({ owners, levels: { atlas: "view" } }).call("POST", "/api/todos", draft({ threadId: "c", botId: "scout" }))).status).toBe(403);
    const forged = setup({ owners, levels: { scout: "view" } });
    expect((await forged.call("POST", "/api/todos", draft({ threadId: "c", botId: "scout", groupId: "other" }))).status).toBe(200);
    expect(forged.store.live()[0]!.source).toEqual({ threadId: "c", botId: "atlas" });
    const room = setup({ owners });
    await room.call("POST", "/api/todos", draft({ threadId: "g1", botId: "atlas" }));
    expect(room.store.live()[0]!.source).toEqual({ threadId: "g1", groupId: "g" });
    const unknown = setup();
    await unknown.call("POST", "/api/todos", draft({ threadId: "c", botId: "atlas", groupId: "g" }));
    expect(unknown.store.live()[0]!.source).toEqual({ threadId: "c" });
  });

  it("hides a todo of an audience the viewer is not in, and gives it a 404 (security)", async () => {
    const { call, store } = setup({ shown: ["member:rama"] });
    store.insert({ ...base, id: "mine", title: "Mine", audience: "member:rama" });
    store.insert({ ...base, id: "theirs", title: "Theirs", audience: "member:sinta" });
    store.insert({ ...base, id: "team", title: "Shared" });
    const listed = (await call("GET", "/api/todos")).body.todos.map((todo: { id: string }) => todo.id).sort();
    expect(listed).toEqual(["mine", "team"]);
    expect((await call("PATCH", "/api/todos/theirs", { title: "x" })).status).toBe(404);
    expect((await call("DELETE", "/api/todos/theirs")).status).toBe(404);
    expect((await call("POST", "/api/todos/theirs/start")).status).toBe(404);
    expect((await call("POST", "/api/todos", { todos: [{ title: "x", botId: "atlas", start: { kind: "after", todoId: "theirs" } }] })).status).toBe(400);
  });

  it("keeps the audience of the source conversation on a new todo, and never sends it to the client (security)", async () => {
    const { call, store } = setup({ audiences: { c: "member:rama" }, shown: ["member:rama"] });
    const added = await call("POST", "/api/todos", { todos: [{ title: "x", source: { threadId: "c" } }, { title: "y" }] });
    expect(added.status).toBe(200);
    expect(store.get(added.body.todos[0].id)!.audience).toBe("member:rama");
    expect(store.get(added.body.todos[1].id)!.audience).toBe("team");
    expect(JSON.stringify(added.body)).not.toContain("audience");
    expect(JSON.stringify((await call("GET", "/api/todos")).body)).not.toContain("audience");
  });

  it("does not let a todo wait for a todo the viewer cannot see (security)", async () => {
    const { call, store } = setup({ hiddenThreads: ["secret"] });
    store.insert({ ...base, id: "h", title: "Hidden", source: { threadId: "secret" } });
    store.insert({ ...base, id: "v", title: "Shown", botId: "atlas", status: "queued" });
    store.insert({ ...base, id: "mine", title: "Mine", botId: "atlas", status: "queued" });
    expect((await call("POST", "/api/todos", { todos: [{ title: "x", botId: "atlas", start: { kind: "after", todoId: "h" } }] })).status).toBe(400);
    expect((await call("POST", "/api/todos", { todos: [{ title: "x", botId: "atlas", start: { kind: "after", todoId: "nope" } }] })).status).toBe(400);
    expect((await call("PATCH", "/api/todos/mine", { start: { kind: "after", todoId: "h" } })).status).toBe(400);
    expect((await call("PATCH", "/api/todos/mine", { start: { kind: "after", todoId: "v" } })).status).toBe(200);
  });

  it("does not name a picker bot the viewer cannot see (security)", async () => {
    const { call } = setup({ hiddenBots: ["scout"] });
    await call("PUT", "/api/todos/picker", { botId: "atlas" });
    expect((await call("GET", "/api/todos")).body.picker).toBe("atlas");
    const { call: other, store } = setup({ hiddenBots: ["scout"] });
    store.setPicker("scout");
    expect((await other("GET", "/api/todos")).body.picker).toBeNull();
  });
});
