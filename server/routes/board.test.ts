import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { VisibleSet } from "../bot-visibility.ts";
import type { BoardSources } from "../board.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createBoardRoutes } from "./board.ts";
import { PASS, type RouteContext } from "./table.ts";

const NOW = 1_800_000_000_000;

function setup(hidden: { threads?: string[]; bots?: string[] } = {}) {
  const sources: BoardSources = {
    handoffs: () => [
      { id: "h1", parentId: "root", threadId: "t-open", botId: "scout", text: "Find the numbers", createdAt: NOW - 1000, status: "running", result: "", mode: "work" },
      { id: "h2", parentId: "root", threadId: "t-secret", botId: "scout", text: "Private work", createdAt: NOW - 1000, status: "running", result: "", mode: "work" },
    ],
    threads: [{ botId: "atlas", task: { threadId: "t-chat", title: "Chat", createdAt: NOW - 5000, activity: "working" } }],
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
  } as unknown as VisibleSet;
  const route = createBoardRoutes({ sources: () => sources, visibleFor: () => visible, now: () => NOW });
  const call = async (method: string, path: string) => {
    const sent: { status?: number; body?: any } = {};
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method,
      auth: { kind: "loopback", scopes: ["client"] } as RequestAuth, readBody: (async () => ({})) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { call };
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
    expect(await call("POST", "/api/board")).toMatchObject({ status: 405, body: { error: "method not allowed" } });
    expect((await call("GET", "/api/boards")).out).toBe(PASS);
  });

  it("leaves out conversations and routine runs the viewer may not see", async () => {
    const { call } = setup({ threads: ["t-secret", "t-chat"], bots: ["ghost"] });
    const { body } = await call("GET", "/api/board");
    expect(body.cards.map((c: { id: string }) => c.id).sort()).toEqual(["handoff:h1", "routine:r1"]);
  });
});
