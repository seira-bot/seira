import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { VisibleSet } from "../bot-visibility.ts";
import type { BoardSources } from "../board.ts";
import type { BoardClosure, BoardClosures } from "../board-closed.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import type { Todo } from "../../shared/todo.ts";
import { createTodoPolicy } from "../host/todo-policy.ts";
import { personKey } from "../person-key.ts";
import type { SessionRecord } from "../sessions.ts";
import type { TodoRecord } from "../todos.ts";
import { createBoardRoutes, type BoardRouteDeps } from "./board.ts";
import { PASS, type RouteContext } from "./table.ts";

const NOW = 1_800_000_000_000;

function setup(hidden: { threads?: string[]; bots?: string[] } = {}, options: { level?: string; more?: ReturnType<BoardSources["handoffs"]>; todos?: Todo[]; deps?: Partial<BoardRouteDeps>; auth?: RequestAuth } = {}) {
  const closed = new Map<string, BoardClosure>();
  const closures: BoardClosures = {
    get: (id) => closed.get(id),
    close: (id, by, reason) => { closed.set(id, { at: NOW, by, ...(reason ? { reason } : {}) }); },
  };
  const sources: BoardSources = {
    handoffs: () => [
      { id: "h1", parentId: "root", threadId: "t-open", botId: "scout", text: "Find the numbers", createdAt: NOW - 1000, status: "running", result: "", mode: "work" },
      { id: "h2", parentId: "root", threadId: "t-secret", botId: "scout", text: "Private work", createdAt: NOW - 1000, status: "running", result: "", mode: "work" },
      ...(options.more ?? []),
    ],
    threads: [{ botId: "atlas", task: { threadId: "t-chat", title: "Chat", createdAt: NOW - 5000, activity: "working" } }],
    ...(options.todos ? { todos: () => ({ todos: options.todos!, picker: null }) } : {}),
    runs: () => [
      { id: "r1", routineId: "rt", routineName: "Digest", botId: "atlas", status: "queued", scheduledFor: NOW - 10 },
      { id: "r2", routineId: "rt", routineName: "Secret digest", botId: "ghost", status: "queued", scheduledFor: NOW - 10 },
      { id: "r3", routineId: "rt", routineName: "Digest", botId: "atlas", status: "running", threadId: "t-secret", scheduledFor: NOW - 10 },
    ],
  };
  const visible = {
    everything: false,
    thread: (id: string) => !(hidden.threads ?? []).includes(id),
    hides: (id: string) => (hidden.threads ?? []).includes(id),
    routineShown: () => true,
    bot: (id: string) => !(hidden.bots ?? []).includes(id),
    group: () => true,
    level: (id: string) => ((hidden.bots ?? []).includes(id) ? "none" : options.level ?? "chat"),
  } as unknown as VisibleSet;
  const route = createBoardRoutes({ sources: () => sources, visibleFor: () => visible, closures, closerName: () => "Rama", now: () => NOW, ...options.deps });
  const call = async (method: string, path: string, body: unknown = {}) => {
    const sent: { status?: number; body?: any } = {};
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method,
      auth: options.auth ?? ({ kind: "loopback", scopes: ["client"] } as RequestAuth), readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { call, closed };
}

describe("GET /api/board", () => {
  it("answers with the cards, and a paired client may read it", async () => {
    const { call } = setup();
    const { status, body } = await call("GET", "/api/board");
    expect(status).toBe(200);
    expect(body.cards.map((c: { id: string }) => c.id).sort()).toEqual(["handoff:h1", "handoff:h2", "routine:r1", "routine:r2", "routine:r3", "thread:t-chat"]);
    expect(requiredScope("GET", "/api/board")).toBe("client");
  });

  it("refuses other methods and leaves other paths alone", async () => {
    const { call } = setup();
    expect(await call("PUT", "/api/board")).toMatchObject({ status: 405, body: { error: "method not allowed" } });
    expect(await call("POST", "/api/board")).toMatchObject({ status: 405, body: { error: "method not allowed" } });
    expect(await call("GET", "/api/board/close")).toMatchObject({ status: 405 });
    expect((await call("GET", "/api/boards")).out).toBe(PASS);
  });

  it("leaves out conversations and routine runs the viewer may not see", async () => {
    const { call } = setup({ threads: ["t-secret", "t-chat"], bots: ["ghost"] });
    const { body } = await call("GET", "/api/board");
    expect(body.cards.map((c: { id: string }) => c.id).sort()).toEqual(["handoff:h1", "routine:r1"]);
  });
});

describe("POST /api/board/close", () => {
  const failed = { id: "h3", parentId: "root", threadId: "t-failed", botId: "scout", text: "Send the report", createdAt: NOW - 5000, status: "failed" as const, result: "It broke", mode: "work" as const };
  const close = (call: ReturnType<typeof setup>["call"], cardId: string, reason?: string) => call("POST", "/api/board/close", { cardId, ...(reason ? { reason } : {}) });

  it("moves a Needs you card to Done with the person's name and reason, and a client may call it", async () => {
    const { call } = setup({}, { more: [failed] });
    expect(await close(call, "handoff:h3", "Fixed by hand")).toMatchObject({ status: 200, body: { ok: true } });
    const { body } = await call("GET", "/api/board");
    expect(body.cards.find((c: { id: string }) => c.id === "handoff:h3")).toMatchObject({
      column: "done", state: "closed", updatedAt: NOW, closedBy: { kind: "person", name: "Rama" }, closedReason: "Fixed by hand",
    });
    expect(requiredScope("POST", "/api/board/close")).toBe("client");
  });

  it("refuses a card the person cannot see, and a card that does not exist, and keeps the card", async () => {
    const { call, closed } = setup({ threads: ["t-failed"] }, { more: [failed] });
    expect(await close(call, "handoff:h3")).toMatchObject({ status: 404 });
    expect(await close(call, "handoff:nope")).toMatchObject({ status: 404 });
    expect(closed.size).toBe(0);
  });

  it("refuses a person who may only view the card's bot, and keeps the card", async () => {
    const { call, closed } = setup({}, { level: "view", more: [failed] });
    expect(await close(call, "handoff:h3")).toMatchObject({ status: 403 });
    expect(closed.size).toBe(0);
    const { body } = await call("GET", "/api/board");
    expect(body.cards.find((c: { id: string }) => c.id === "handoff:h3")).toMatchObject({ column: "needs-you" });
  });

  it("refuses a card that is not in Needs you, and a card that is already in Done", async () => {
    const { call, closed } = setup({}, { more: [failed] });
    expect(await close(call, "handoff:h1")).toMatchObject({ status: 409 });
    expect(await close(call, "handoff:h3")).toMatchObject({ status: 200 });
    expect(await close(call, "handoff:h3")).toMatchObject({ status: 409 });
    expect([...closed.keys()]).toEqual(["handoff:h3"]);
  });

  it("refuses a body without a card id or with a reason that is too long", async () => {
    const { call, closed } = setup({}, { more: [failed] });
    expect(await call("POST", "/api/board/close", {})).toMatchObject({ status: 400 });
    expect(await close(call, "handoff:h3", "x".repeat(201))).toMatchObject({ status: 400 });
    expect(closed.size).toBe(0);
  });
});

describe("security: a person's todo on the Board", () => {
  const todo = (id: string): Todo => ({
    id, title: `Todo ${id}`, botId: "atlas", status: "needs-you", stuck: "unassigned", start: { kind: "free" }, rank: 1,
    madeBy: { kind: "person", name: "Pat" }, attempts: 0, depth: 0, createdAt: NOW - 100, updatedAt: NOW - 100,
  });

  it("shows only the todos this person may read, and a hidden one cannot be closed", async () => {
    const closedTodos: string[] = [];
    const { call } = setup({}, { todos: [todo("mine"), todo("theirs")], deps: { todoReadable: (_auth, id) => id === "mine", closeTodo: (id) => { closedTodos.push(id); } } });
    const board = await call("GET", "/api/board");
    const ids = (board.body.cards as Array<{ id: string }>).map((card) => card.id);
    expect(ids).toContain("todo:mine");
    expect(ids).not.toContain("todo:theirs");
    expect(await call("POST", "/api/board/close", { cardId: "todo:theirs" })).toMatchObject({ status: 404 });
    expect(closedTodos).toEqual([]);
  });

  it("refuses to close a todo the person may not change, and keeps it open", async () => {
    const closedTodos: string[] = [];
    const { call } = setup({}, { todos: [todo("owners")], deps: { todoCloseRefusal: () => "On this Cloud you can only change todos you made.", closeTodo: (id) => { closedTodos.push(id); } } });
    expect(await call("POST", "/api/board/close", { cardId: "todo:owners" })).toMatchObject({ status: 403, body: { error: "On this Cloud you can only change todos you made." } });
    expect(closedTodos).toEqual([]);
  });

  it("never lets a guest close a todo another person wrote, by the Cloud's own rule", async () => {
    const guest = { id: "s-pat", email: "pat@example.com" } as SessionRecord;
    const records: Record<string, TodoRecord> = {
      theirs: { ...todo("theirs"), person: { key: "p_owner" } },
      mine: { ...todo("mine"), person: { key: personKey(guest) } },
    };
    const rules = createTodoPolicy({
      mode: "personal", nobodyKey: "p_nobody", outsideKey: "p_outside", actorKey: (auth) => personKey(auth.session),
      ownerSession: (auth) => auth.kind === "session" && auth.scopes.includes("admin"), ownerPerson: (key) => key === "p_owner",
      viewerFor: () => ({ kind: "member" }), level: () => "chat", teamPeople: () => [], signedIn: () => [], audienceOf: () => "team",
      readableFrom: () => () => true, guestDriven: () => false, outsideDriven: () => false, outsideStaysHere: () => false, openerFrom: () => undefined,
    });
    const closedTodos: string[] = [];
    const { call } = setup({}, {
      todos: [todo("theirs"), todo("mine")], auth: { kind: "session", session: guest, via: "cookie", scopes: ["client"] },
      deps: { todoReadable: (auth, id) => rules.sessionMayRead(auth, records[id]!), todoCloseRefusal: (auth, id) => rules.changeRefusal(auth, records[id]!), closeTodo: (id) => { closedTodos.push(id); } },
    });
    expect((await call("POST", "/api/board/close", { cardId: "todo:theirs" })).status).toBe(404);
    expect(closedTodos).toEqual([]);
    expect((await call("POST", "/api/board/close", { cardId: "todo:mine" })).status).toBe(200);
    expect(closedTodos).toEqual(["mine"]);
  });

  it("closes a todo the person may change", async () => {
    const closedTodos: string[] = [];
    const { call } = setup({}, { todos: [todo("mine")], deps: { todoReadable: () => true, todoCloseRefusal: () => null, closeTodo: (id) => { closedTodos.push(id); } } });
    expect(await call("POST", "/api/board/close", { cardId: "todo:mine" })).toMatchObject({ status: 200 });
    expect(closedTodos).toEqual(["mine"]);
  });
});
