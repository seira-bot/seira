import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTodosHost, type TodoBot } from "../host/todos-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TodoStore } from "../todos.ts";
import { batchLine, createInternalTodoRoutes } from "./internal-todos.ts";
import { PASS, type RouteContext } from "./table.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const BOTS: TodoBot[] = [{ id: "atlas", name: "Atlas" }, { id: "scout", name: "Scout" }, { id: "chief", name: "Chief", chiefOfStaff: true }];

function setup(readable: (todo: { source?: { threadId: string } }) => boolean = () => true) {
  const dir = mkdtempSync(join(tmpdir(), "todo-internal-"));
  dirs.push(dir);
  let n = 0;
  const store = new TodoStore({ dataDir: dir, newId: () => `t${++n}` });
  const host = createTodosHost({ store, bots: () => BOTS, routines: () => null, teamCloud: false, levelFor: () => "chat" });
  const lines: Array<[string, string, string[]]> = [];
  const route = createInternalTodoRoutes({ host, from: { id: "chief" }, fromThreadId: "th", readBody: async () => null, readable: readable as never, botName: (id) => BOTS.find((bot) => bot.id === id)?.name, postLine: (thread, text, ids) => { lines.push([thread, text, ids]); } });
  const call = async (method: string, path: string, body: unknown = {}) => {
    const sent: { status?: number; body?: any } = {};
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method,
      auth: { kind: "loopback", scopes: ["client"] } as RequestAuth, readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, payload: unknown) => { sent.status = status; sent.body = payload; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { call, store, host, lines };
}

describe("internal todo routes", () => {
  it("passes other paths on", async () => expect((await setup().call("GET", "/api/internal/other")).out).toBe(PASS));

  it("adds todos for the calling bot and posts one line in its conversation (AC-16)", async () => {
    const dir = setup();
    const route = createInternalTodoRoutes({ host: dir.host, from: { id: "chief" }, fromThreadId: "th", person: () => ({ key: "p_guest" }), readBody: async () => ({ todos: [{ title: "Check logs", assigneeBotId: "Scout" }] }), readable: () => true, botName: (id) => BOTS.find((bot) => bot.id === id)?.name, postLine: (thread, text, ids) => { dir.lines.push([thread, text, ids]); } });
    const sent: any = {};
    await route({ req: {} as never, res: {} as never, url: new URL("/api/internal/todos", "http://x"), path: "/api/internal/todos", method: "POST", auth: {} as never, readBody: (async () => null) as never, json: ((_r: unknown, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as never });
    expect(sent.status).toBe(200);
    expect(sent.body.added[0]).toMatchObject({ title: "Check logs", botId: "scout", botName: "Scout" });
    expect(sent.body.added[0].person).toBeUndefined();
    // Its own conversation opens as the person of the conversation the bot was in (security).
    expect(dir.store.get(sent.body.added[0].id)!.person).toEqual({ key: "p_guest" });
    expect(dir.lines).toHaveLength(1);
    expect(dir.lines[0]![1]).toContain("Check logs");
  });

  it("lists only todos the caller may read", async () => {
    const { call, host } = setup((todo) => todo.source?.threadId !== "private");
    host.add([{ title: "Public" }, { title: "Private", source: { threadId: "private" } }], { kind: "person", name: "R" });
    const listed = await call("GET", "/api/internal/todos");
    expect(listed.body.todos.map((todo: { title: string }) => todo.title)).toEqual(["Public"]);
  });

  it("answers 404 for assign and update of a todo the caller may not read (security)", async () => {
    const ctx = setup((todo) => todo.source?.threadId !== "private");
    const todo = ctx.host.add([{ title: "Private", source: { threadId: "private" } }], { kind: "person", name: "R" }).todos[0]!;
    for (const [path, body] of [["/api/internal/todos/assign", { todoId: todo.id, assigneeBotId: "scout", reason: "r" }], ["/api/internal/todos/update", { todoId: todo.id, status: "done" }]] as const) {
      const route = createInternalTodoRoutes({ host: ctx.host, from: { id: "chief" }, fromThreadId: "th", readBody: async () => body, readable: (one) => one.source?.threadId !== "private", botName: () => undefined, postLine: () => {} });
      const sent: any = {};
      await route({ req: {} as never, res: {} as never, url: new URL(path, "http://x"), path, method: "POST", auth: {} as never, readBody: (async () => null) as never, json: ((_r: unknown, status: number, payload: unknown) => { sent.status = status; sent.body = payload; }) as never });
      expect(sent.status).toBe(404);
    }
    expect(ctx.store.get(todo.id)!.status).toBe("open");
  });

  it("never matches a todo the caller may not read when a bot adds one with the same title (security)", async () => {
    const ctx = setup();
    const hidden = ctx.host.add([{ title: "Pay the team", botId: "scout", source: { threadId: "private" } }], { kind: "person", name: "Owner" }).todos[0]!;
    const add = async (readable: (todo: { source?: { threadId: string } }) => boolean) => {
      const route = createInternalTodoRoutes({ host: ctx.host, from: { id: "chief" }, fromThreadId: "th", readBody: async () => ({ todos: [{ title: "Pay the team", assigneeBotId: "Scout" }, { title: "Tell the team", afterIndex: 0 }] }), readable: readable as never, botName: () => undefined, postLine: () => {} });
      const sent: any = {};
      await route({ req: {} as never, res: {} as never, url: new URL("/api/internal/todos", "http://x"), path: "/api/internal/todos", method: "POST", auth: {} as never, readBody: (async () => null) as never, json: ((_r: unknown, status: number, payload: unknown) => { sent.status = status; sent.body = payload; }) as never });
      return sent;
    };
    const refused = await add((todo) => todo.source?.threadId !== "private");
    expect(refused.status).toBe(200);
    expect(refused.body.existing).toEqual([]);
    expect(refused.body.added.map((todo: { title: string }) => todo.title)).toEqual(["Pay the team", "Tell the team"]);
    const [own, next] = refused.body.added as Array<{ id: string }>;
    expect(own!.id).not.toBe(hidden.id);
    expect(ctx.store.get(next!.id)!.start).toEqual({ kind: "after", todoId: own!.id });
    expect(ctx.store.get(hidden.id)).toMatchObject({ title: "Pay the team", status: "queued" });
    // A caller that may read the todo still gets the match.
    expect((await add(() => true)).body.existing[0].id).toBe(hidden.id);
  });

  it("refuses a repeating todo from a bot with a plain reason", async () => {
    const ctx = setup();
    const route = createInternalTodoRoutes({ host: ctx.host, from: { id: "chief" }, fromThreadId: "th", readBody: async () => ({ todos: [{ title: "Daily", repeat: { time: "09:00", weekdays: [] } }] }), readable: () => true, botName: () => undefined, postLine: () => {} });
    const sent: any = {};
    await route({ req: {} as never, res: {} as never, url: new URL("/api/internal/todos", "http://x"), path: "/api/internal/todos", method: "POST", auth: {} as never, readBody: (async () => null) as never, json: ((_r: unknown, status: number, payload: unknown) => { sent.status = status; sent.body = payload; }) as never });
    expect(sent.status).toBe(403);
    expect(sent.body.error).toMatch(/routine request tool/);
  });

  it("writes the batch line with the bot of each todo", () => {
    expect(batchLine([{ title: "A", botId: "scout" }, { title: "B" }] as never, () => "Scout")).toBe("Added 2 todos:\n- A (Scout)\n- B (no bot yet)");
  });
});
