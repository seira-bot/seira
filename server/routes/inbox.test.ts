import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";

import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { BEN, CLEO, session, teamInbox } from "../testing/team-inbox-fixture.ts";
import { createInboxRoutes } from "./inbox.ts";
import { PASS, type RouteContext } from "./table.ts";

const fixtures: Array<ReturnType<typeof teamInbox>> = [];
afterEach(() => { for (const made of fixtures.splice(0)) made.close(); });

function setup(options: Parameters<typeof teamInbox>[0] = {}) {
  const f = teamInbox(options);
  fixtures.push(f);
  const route = createInboxRoutes(f.team);
  const call = async (method: string, path: string, auth: RequestAuth = session(BEN.email), body: unknown = {}) => {
    const sent: { status?: number; body?: any } = {};
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method, auth,
      readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { f, call };
}

it("answers each member with their own inbox, which a client session may read and mark", async () => {
  const { f, call } = setup();
  f.team.pass("scout", "cleo-private", "Ben", "The launch moved to Friday.");
  expect(await call("GET", "/api/inbox/count")).toMatchObject({ status: 200, body: { count: 1 } });
  expect(requiredScope("GET", "/api/inbox/count")).toBe("client");
  const mine = await call("GET", "/api/inbox");
  expect(mine).toMatchObject({ status: 200, body: { botId: "bens-chief", rows: [{ text: "The launch moved to Friday.", tab: "info", unread: true }] } });
  const line = mine.body.rows[0].id as string;
  expect((await call("POST", `/api/inbox/${line}/read`)).body.rows[0]).toMatchObject({ unread: false, tab: "info" });
  expect((await call("POST", `/api/inbox/${line}/done`)).body.rows[0]).toMatchObject({ tab: "done" });
  expect(await call("POST", `/api/inbox/${line}/done`, session(CLEO.email)), "someone else's line").toMatchObject({ status: 404, body: { error: "That line is not in your inbox.", errorKey: "serverError.inbox.lineMissing" } });
  expect((await call("GET", "/api/inbox", session(CLEO.email))).body.rows).toEqual([]);
  expect(await call("DELETE", "/api/inbox")).toMatchObject({ status: 405 });
  expect((await call("GET", "/api/needs-you")).out).toBe(PASS);
  for (const [method, path] of [["GET", "/api/inbox"], ["POST", `/api/inbox/${line}/read`], ["POST", `/api/inbox/${line}/done`]] as const) {
    expect(requiredScope(method, path), `${method} ${path}`).toBe("client");
  }
});

it("refuses to mark an open ask done, which only its answer settles", async () => {
  const { f, call } = setup();
  f.bots.find((bot) => bot.id === "reporter")!.tasks.push({ threadId: "rep-shared", title: "Weekly numbers" });
  f.store.appendMessage("rep-shared", { role: "bot", kind: "options", text: "Run a command?", card: { title: "Run a command?", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], requestId: "req-1", tool: "Bash", requestType: "permission" } });
  f.team.route({ kind: "approval", botId: "reporter", botName: "Reporter", threadId: "rep-shared", title: "Reporter needs approval", body: "Run: rm -rf ./build" });
  const [ask] = (await call("GET", "/api/inbox")).body.rows;
  expect(ask).toMatchObject({ tab: "needs-you", card: { requestId: "req-1" } });
  expect(await call("POST", `/api/inbox/${ask.id}/done`)).toMatchObject({ status: 409, body: { error: "This waits on your answer: answer it, or close it, where it asks.", errorKey: "serverError.inbox.answerRequired" } });
});

it("has no inbox off a team", async () => {
  const { call } = setup({ team: false });
  expect(await call("GET", "/api/inbox")).toMatchObject({ status: 404, body: { error: "There is no inbox here.", errorKey: "serverError.inbox.missing" } });
});

it("reads every unread line at once for the caller alone, leaves an ask waiting on its card, and repeats harmlessly", async () => {
  const { f, call } = setup();
  f.bots.find((bot) => bot.id === "reporter")!.tasks.push({ threadId: "rep-shared", title: "Weekly numbers" });
  f.team.pass("scout", "cleo-private", "Ben", "The launch moved to Friday.");
  f.team.pass("scout", "ben-private", "Cleo", "Cleo, the draft is ready.");
  f.store.appendMessage("rep-shared", { role: "bot", kind: "options", text: "Run a command?", card: { title: "Run a command?", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], requestId: "req-1", tool: "Bash", requestType: "permission" } });
  f.team.route({ kind: "approval", botId: "reporter", botName: "Reporter", threadId: "rep-shared", title: "Reporter needs approval", body: "Run: rm -rf ./build" });
  const before = (await call("GET", "/api/inbox")).body.rows as Array<{ id: string; tab: string; unread: boolean; card?: unknown }>;
  expect(before.length).toBeGreaterThanOrEqual(2);
  expect(before.every((row) => row.unread)).toBe(true);
  const cleoBefore = (await call("GET", "/api/inbox", session(CLEO.email))).body.rows as Array<{ unread: boolean }>;
  expect(cleoBefore.some((row) => row.unread)).toBe(true);

  const first = await call("POST", "/api/inbox/read-all");
  expect(first.status).toBe(200);
  expect(first.body.rows.map((row: { id: string }) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  expect(first.body.rows.every((row: { unread: boolean }) => !row.unread)).toBe(true);
  expect(first.body.rows.map((row: { id: string; tab: string }) => [row.id, row.tab]).sort()).toEqual(before.map((row) => [row.id, row.tab]).sort());
  const ask = first.body.rows.find((row: { kind: string }) => row.kind === "ask");
  expect(ask, "the ask is still listed, on the needs-you tab, with its card unanswered").toMatchObject({ tab: "needs-you", unread: false, card: { requestId: "req-1" } });
  expect(ask.card.answered).toBeUndefined();
  expect(f.store.messagesFor("rep-shared").find((message) => message.kind === "options")!.card).not.toHaveProperty("answered");

  expect(await call("POST", "/api/inbox/read-all")).toMatchObject({ status: 200, body: first.body });
  expect((await call("GET", "/api/inbox/count")).body.count, "only the ask still waits on them").toBe(1);
  expect(f.team.markAllRead(session(BEN.email))).toBe(0);

  expect((await call("GET", "/api/inbox", session(CLEO.email))).body.rows, "another person's rows stay unread").toEqual(cleoBefore);
  expect(await call("GET", "/api/inbox/read-all")).toMatchObject({ status: 405 });
  expect(await call("POST", "/api/inbox/read-all", session("stranger@nowhere.test"))).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
  expect(requiredScope("POST", "/api/inbox/read-all")).toBe("client");
});

it("has no bulk read off a team", async () => {
  const { call } = setup({ team: false });
  expect(await call("POST", "/api/inbox/read-all")).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
});

it("marks news done in one call: the named lines, or all news, never an ask, and answers 400 to a bad list", async () => {
  const { f, call } = setup();
  f.team.pass("scout", "cleo-private", "Ben", "First news.");
  f.team.pass("scout", "cleo-private", "Ben", "Second news.");
  f.team.pass("scout", "cleo-private", "Ben", "Third news.");
  const [first] = (await call("GET", "/api/inbox")).body.rows as Array<{ id: string }>;
  const tabs = async () => ((await call("GET", "/api/inbox")).body.rows as Array<{ tab: string }>).map((row) => row.tab);
  const bad = { status: 400, body: { error: "Those Inbox items could not be marked done.", errorKey: "serverError.inbox.badIds" } };
  const tooMany = Array.from({ length: 501 }, (_, i) => `id-${i}`);
  for (const body of [[], "text", null, { ids: "x" }, { ids: [1] }, { ids: [""] }, { ids: ["x".repeat(513)] }, { ids: tooMany }]) {
    expect(await call("POST", "/api/inbox/done-all", session(BEN.email), body), JSON.stringify(body).slice(0, 40)).toMatchObject(bad);
  }
  expect(await tabs(), "a refused request changes nothing").toEqual(["info", "info", "info"]);
  expect((await call("POST", "/api/inbox/done-all", session(BEN.email), { ids: [first!.id] })).body.rows.filter((row: { tab: string }) => row.tab === "done")).toHaveLength(1);
  expect(await call("POST", "/api/inbox/done-all", session(BEN.email), { ids: [] })).toMatchObject({ status: 200 });
  expect((await call("POST", "/api/inbox/done-all")).status).toBe(200);
  expect(await tabs()).toEqual(["done", "done", "done"]);
  expect(await call("GET", "/api/inbox/done-all")).toMatchObject({ status: 405 });
  expect(requiredScope("POST", "/api/inbox/done-all")).toBe("client");
});

it("has no done-all off a team", async () => {
  const { call } = setup({ team: false });
  expect(await call("POST", "/api/inbox/done-all")).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
});

it("clears a line's decision mark through not-decision: 200 with the inbox, 404 for an unknown line or no inbox, 405 for another method", async () => {
  const view = { botId: null, threadId: null, rows: [], anchor: null };
  const outcomes: Array<boolean | null> = [true, false, null];
  const asked: string[] = [];
  const route = createInboxRoutes({
    view: () => view, count: () => 0, markDone: () => "done", markDoneMany: () => 0, markRead: () => true, markAllRead: () => 0,
    notDecision: (_auth, id) => { asked.push(id); return outcomes.shift() ?? null; },
    summarize: async () => null, hideSummary: () => null, setSummarizer: () => null,
  });
  const call = async (method: string, path: string) => {
    const sent: { status?: number; body?: any } = {};
    await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method, auth: session(BEN.email),
      readBody: (async () => ({})) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return sent;
  };
  expect(await call("POST", "/api/inbox/line-1/not-decision")).toMatchObject({ status: 200, body: view });
  expect(await call("POST", "/api/inbox/line-2/not-decision")).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.lineMissing" } });
  expect(await call("POST", "/api/inbox/line-3/not-decision")).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
  expect(await call("GET", "/api/inbox/line-1/not-decision")).toMatchObject({ status: 405 });
  expect(asked).toEqual(["line-1", "line-2", "line-3"]);
  expect(requiredScope("POST", "/api/inbox/line-1/not-decision")).toBe("client");
});

it("has no not-decision for someone on a team, whose inbox is not sorted", async () => {
  const { f, call } = setup();
  f.team.pass("scout", "cleo-private", "Ben", "The launch moved to Friday.");
  const [row] = (await call("GET", "/api/inbox")).body.rows;
  expect(await call("POST", `/api/inbox/${row.id}/not-decision`)).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
});

function summaryRoutes(outcomes: Array<"ok" | "unknown" | "refused" | null> = ["ok"]) {
  const view = { botId: null, threadId: null, rows: [], anchor: null };
  const seen: Array<[string, unknown]> = [];
  const route = createInboxRoutes({
    view: () => view, count: () => 0, markDone: () => "done", markDoneMany: () => 0, markRead: () => true, markAllRead: () => 0, notDecision: () => true,
    summarize: async (_auth, options) => { seen.push(["summarize", options]); return view; },
    hideSummary: (_auth, wrong) => { seen.push(["hide", wrong]); return view; },
    setSummarizer: (_auth, botId) => { seen.push(["summarizer", botId]); return outcomes.shift() ?? null; },
  });
  const call = async (method: string, path: string, body: unknown = {}) => {
    const sent: { status?: number; body?: any } = {};
    await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method, auth: session(BEN.email),
      readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return sent;
  };
  return { view, seen, call };
}

it("writes the summary on request, waiting for it: 200 with the inbox, 400 for a force that is not true or false, 405 for another method", async () => {
  const { view, seen, call } = summaryRoutes();
  expect(await call("POST", "/api/inbox/summary")).toMatchObject({ status: 200, body: view });
  expect(await call("POST", "/api/inbox/summary", { force: true })).toMatchObject({ status: 200 });
  expect(await call("POST", "/api/inbox/summary", { force: false })).toMatchObject({ status: 200 });
  expect(seen).toEqual([["summarize", { force: false }], ["summarize", { force: true }], ["summarize", { force: false }]]);
  for (const body of [{ force: "yes" }, { force: 1 }, [], "text"]) {
    expect(await call("POST", "/api/inbox/summary", body), JSON.stringify(body)).toMatchObject({ status: 400, body: { errorKey: "serverError.inbox.badSummary" } });
  }
  expect(seen, "a refused request asked for nothing").toHaveLength(3);
  expect(await call("GET", "/api/inbox/summary")).toMatchObject({ status: 405 });
  expect(requiredScope("POST", "/api/inbox/summary")).toBe("client");
});

it("hides the summary: 200 with the inbox, 400 for a wrong that is not true or false, 405 for another method", async () => {
  const { view, seen, call } = summaryRoutes();
  expect(await call("POST", "/api/inbox/summary/hide")).toMatchObject({ status: 200, body: view });
  expect(await call("POST", "/api/inbox/summary/hide", { wrong: true })).toMatchObject({ status: 200 });
  expect(seen).toEqual([["hide", false], ["hide", true]]);
  expect(await call("POST", "/api/inbox/summary/hide", { wrong: "no" })).toMatchObject({ status: 400, body: { errorKey: "serverError.inbox.badSummary" } });
  expect(await call("GET", "/api/inbox/summary/hide")).toMatchObject({ status: 405 });
  expect(requiredScope("POST", "/api/inbox/summary/hide")).toBe("client");
});

it("picks who writes the summary: 200, 400 for a bad body or an unknown bot, 403 for someone who is not the owner, 404 with no inbox, 405 for another method", async () => {
  const { view, seen, call } = summaryRoutes(["ok", "ok", "unknown", "refused", null]);
  expect(await call("POST", "/api/inbox/summarizer", { botId: "mira" })).toMatchObject({ status: 200, body: view });
  expect(await call("POST", "/api/inbox/summarizer", { botId: null })).toMatchObject({ status: 200 });
  expect(await call("POST", "/api/inbox/summarizer", { botId: "ghost" })).toMatchObject({ status: 400, body: { errorKey: "serverError.inbox.badSummarizer", error: "That bot cannot write your Inbox summary." } });
  expect(await call("POST", "/api/inbox/summarizer", { botId: "mira" })).toMatchObject({ status: 403, body: { errorKey: "serverError.inbox.summaryOwnerOnly" } });
  expect(await call("POST", "/api/inbox/summarizer", { botId: "mira" })).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
  const asked = seen.length;
  for (const body of [{}, { botId: 5 }, { botId: "" }, { botId: "x".repeat(513) }, [], "mira", null]) {
    expect(await call("POST", "/api/inbox/summarizer", body), JSON.stringify(body)).toMatchObject({ status: 400, body: { errorKey: "serverError.inbox.badSummarizer" } });
  }
  expect(seen, "a bad body asked for nothing").toHaveLength(asked);
  expect(await call("GET", "/api/inbox/summarizer")).toMatchObject({ status: 405 });
  expect(requiredScope("POST", "/api/inbox/summarizer")).toBe("client");
});

it("has no summary for someone on a team, or with no inbox", async () => {
  for (const options of [{}, { team: false }]) {
    const { call } = setup(options);
    for (const path of ["/api/inbox/summary", "/api/inbox/summary/hide", "/api/inbox/summarizer"]) {
      expect(await call("POST", path, session(BEN.email), { botId: "scout" }), `${JSON.stringify(options)} ${path}`).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
    }
  }
});
