// A team suggestion for a conversation the caller cannot see answers 404 and never reaches the store.
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import { createTeamRoutes, type TeamRouteDeps } from "./teams.ts";
import type { RouteContext } from "./table.ts";

const admin: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member: RequestAuth = { kind: "loopback", trust: "service", scopes: ["client"] };
const NOT_FOUND = { error: "This conversation was not found." };

function fixture() {
  const touched: string[] = [];
  const store = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`The route reached the store: ${String(property)}`);
    },
  }) as unknown as Store;
  const deps = {
    store,
    routines: () => null,
    orgLibrary: () => null,
    broadcast: vi.fn(),
    publicBot: vi.fn(),
    publicGroupState: vi.fn(),
    groupWithThread: vi.fn(),
    defaultSelection: vi.fn(),
    packageImportDeps: vi.fn(),
    threadShown: () => (id: string) => id !== "t-hidden",
  } as unknown as TeamRouteDeps;
  const handler = createTeamRoutes(deps);
  const call = async (path: string, auth: RequestAuth, threadId: string) => {
    let answer: { status: number; body: unknown } | undefined;
    const ctx = {
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost${path}`),
      path,
      method: "POST",
      auth,
      json: (_res: ServerResponse, status: number, body: unknown) => { answer = { status, body }; },
      readBody: async () => ({ threadId, keep: [] }),
    } as unknown as RouteContext;
    await handler(ctx);
    return answer;
  };
  return { call, touched };
}

describe("team suggestion visibility", () => {
  it("answers 404 when an admin creates a team for a hidden conversation", async () => {
    const { call, touched } = fixture();
    expect(await call("/api/teams/suggestion/msg-1", admin, "t-hidden")).toEqual({ status: 404, body: NOT_FOUND });
    expect(touched).toEqual([]);
  });

  it("answers 404 when an admin skips a suggestion in a hidden conversation", async () => {
    const { call, touched } = fixture();
    expect(await call("/api/teams/suggestion/msg-1/skip", admin, "t-hidden")).toEqual({ status: 404, body: NOT_FOUND });
    expect(touched).toEqual([]);
  });

  it("answers 403 to a member before it checks the conversation", async () => {
    const { call, touched } = fixture();
    const answer = await call("/api/teams/suggestion/msg-1", member, "t-hidden");
    expect(answer?.status).toBe(403);
    expect(touched).toEqual([]);
  });
});
