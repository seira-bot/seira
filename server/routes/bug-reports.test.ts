import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { BugDraftView } from "../../shared/bug-offer.ts";
import { json, readBody } from "../harness/http.ts";
import type { DraftRefusal } from "../host/devs-reports.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBugReportRoutes, type BugReportRoutesDeps } from "./bug-reports.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const ANA_DRAFT = "draft-ana-0001";
const view = (id: string, state: BugDraftView["state"] = "offer"): BugDraftView => ({
  id, from: "error", by: "Scout", state, title: "A turn stops: x is not a function", description: "What happened", diagnostics: "## Error",
  included: { version: "0.1.179", platform: "linux x64", activity: 0 }, direct: true, formUrl: "https://github.com/seira-bot/seira/issues/new",
});

/** Two members on one server: Ana asked for the report in the room, Budi sees the room too, and "private" is Ana's own chat. */
function reports(options: { send?: BugDraftView | DraftRefusal; dismiss?: "ok" | "gone" | "busy" } = {}) {
  const calls: string[] = [];
  const fake: BugReportRoutesDeps["reports"] = {
    draftThread: (id) => (id === ANA_DRAFT ? "room" : id === "draft-private1" ? "private" : null),
    viewDraft: (id, person) => { calls.push(`view ${id} ${person}`); return person === "ana" ? view(id) : null; },
    sendDraft: async (id, person) => { calls.push(`send ${id} ${person}`); return person === "ana" ? options.send ?? view(id, "sent") : { error: "gone" }; },
    dismissDraft: (id, person) => { calls.push(`dismiss ${id} ${person}`); return person === "ana" ? options.dismiss ?? "ok" : "gone"; },
    fromError: (threadId, text, person) => { calls.push(`error ${threadId} ${person}`); return /TypeError/.test(text) ? view("draft-new-0001") : null; },
  };
  return { fake, calls };
}

async function serve(fake: BugReportRoutesDeps["reports"]): Promise<string> {
  const routes = [createBugReportRoutes({
    reports: fake,
    person: (auth) => (auth as unknown as { who: string }).who,
    sees: (auth, threadId) => threadId === "room" || (threadId === "private" && (auth as unknown as { who: string }).who === "ana"),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["chat"], who: String(req.headers["x-who"] ?? "") } as unknown as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const as = (who: string, init: RequestInit = {}) => ({ ...init, headers: { "content-type": "application/json", "x-who": who } });

describe("a bug report draft through the route table (AC-11)", () => {
  it("opens, goes and goes away only for the person it is for", async () => {
    const { fake, calls } = reports();
    const base = await serve(fake);
    expect((await fetch(`${base}/api/bug-reports/drafts/${ANA_DRAFT}`, as("budi"))).status).toBe(404);
    expect((await fetch(`${base}/api/bug-reports/drafts/${ANA_DRAFT}/send`, as("budi", { method: "POST" }))).status).toBe(404);
    expect((await fetch(`${base}/api/bug-reports/drafts/${ANA_DRAFT}/dismiss`, as("budi", { method: "POST" }))).status).toBe(404);

    const read = await fetch(`${base}/api/bug-reports/drafts/${ANA_DRAFT}`, as("ana"));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: ANA_DRAFT, state: "offer" });
    const sent = await fetch(`${base}/api/bug-reports/drafts/${ANA_DRAFT}/send`, as("ana", { method: "POST" }));
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ state: "sent" });
    const dismissed = await fetch(`${base}/api/bug-reports/drafts/${ANA_DRAFT}/dismiss`, as("ana", { method: "POST" }));
    expect(dismissed.status).toBe(204);
    expect(calls).toEqual([`view ${ANA_DRAFT} budi`, `send ${ANA_DRAFT} budi`, `dismiss ${ANA_DRAFT} budi`, `view ${ANA_DRAFT} ana`, `send ${ANA_DRAFT} ana`, `dismiss ${ANA_DRAFT} ana`]);
  });

  it("answers a conversation the reader cannot see as if the draft were gone, without asking about it", async () => {
    const { fake, calls } = reports();
    const base = await serve(fake);
    const hidden = await fetch(`${base}/api/bug-reports/drafts/draft-private1`, as("budi"));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "That report is gone." });
    expect((await fetch(`${base}/api/bug-reports/drafts/unknown-draft1`, as("ana"))).status).toBe(404);
    const made = await fetch(`${base}/api/bug-reports/drafts`, as("budi", { method: "POST", body: JSON.stringify({ threadId: "private", error: "TypeError: x" }) }));
    expect(made.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("says when a draft is on its way, or could not go", async () => {
    const busy = await serve(reports({ dismiss: "busy", send: { error: "refused", detail: "too long" } }).fake);
    const notNow = await fetch(`${busy}/api/bug-reports/drafts/${ANA_DRAFT}/dismiss`, as("ana", { method: "POST" }));
    expect(notNow.status).toBe(409);
    expect(await notNow.json()).toEqual({ error: "This report is already on its way." });
    const refused = await fetch(`${busy}/api/bug-reports/drafts/${ANA_DRAFT}/send`, as("ana", { method: "POST" }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "The report could not be sent. Try again later." });
    expect((await fetch(`${busy}/api/bug-reports/drafts/${ANA_DRAFT}/send`, as("ana"))).status).toBe(405);
  });

  it("makes a draft from a failed request only for Seira's own error, for the reader", async () => {
    const { fake, calls } = reports();
    const base = await serve(fake);
    const made = await fetch(`${base}/api/bug-reports/drafts`, as("budi", { method: "POST", body: JSON.stringify({ threadId: "room", error: "TypeError: x is not a function" }) }));
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({ id: "draft-new-0001", state: "offer" });
    const not = await fetch(`${base}/api/bug-reports/drafts`, as("budi", { method: "POST", body: JSON.stringify({ threadId: "room", error: "signed out" }) }));
    expect(not.status).toBe(422);
    const bad = await fetch(`${base}/api/bug-reports/drafts`, as("budi", { method: "POST", body: JSON.stringify({ threadId: "room", error: "TypeError", extra: 1 }) }));
    expect(bad.status).toBe(400);
    expect(calls).toEqual(["error room budi", "error room budi"]);
  });
});
