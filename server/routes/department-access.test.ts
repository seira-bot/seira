import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { DepartmentAccessView } from "../../shared/department-access.ts";
import type { RequestAuth } from "./../request-auth.ts";
import { createDepartmentAccessRoutes } from "./department-access.ts";
import { PASS, type RouteContext } from "./table.ts";

const admin = { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth;
const member = { kind: "session", scopes: ["client"] } as unknown as RequestAuth;
const view: DepartmentAccessView = { available: true, people: { "ada@acme.test": ["Sales"] }, unreadable: false };

function fixture(result: ReturnType<typeof vi.fn> = vi.fn(() => ({ ok: true }))) {
  const handler = createDepartmentAccessRoutes({ view: () => view, change: result as never });
  const call = async (method: string, body?: unknown, auth: RequestAuth = admin, path = "/api/department-access") => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://localhost${path}`), path, method, auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    return { out, sent: sent[0] };
  };
  return { call, result };
}

describe("/api/department-access", () => {
  it("passes other paths and methods", async () => {
    expect((await fixture().call("GET", undefined, admin, "/api/other")).out).toBe(PASS);
    expect((await fixture().call("DELETE")).out).toBe(PASS);
  });

  it("lists the grants for an admin", async () => {
    expect((await fixture().call("GET")).sent).toEqual({ status: 200, body: view });
  });

  it("refuses a member, for reading and for changing", async () => {
    const { call, result } = fixture();
    expect((await call("GET", undefined, member)).sent!.status).toBe(403);
    expect((await call("PUT", { entry: "ada@acme.test", departments: null }, member)).sent!.status).toBe(403);
    expect(result).not.toHaveBeenCalled();
  });

  it("changes a grant and answers with the list", async () => {
    const { call, result } = fixture();
    const body = { entry: "ada@acme.test", departments: ["Sales"] };
    expect((await call("PUT", body)).sent).toEqual({ status: 200, body: view });
    expect(result).toHaveBeenCalledWith(body);
  });

  it("passes the refusal on", async () => {
    const { call } = fixture(vi.fn(() => ({ ok: false, status: 404, error: "No such department" })));
    expect((await call("PUT", { entry: "ada@acme.test", departments: ["Legal"] })).sent).toEqual({ status: 404, body: { error: "No such department" } });
  });
});
