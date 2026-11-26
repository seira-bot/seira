import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { GroupRecord } from "../store.ts";
import { createGroupRoutes } from "./groups.ts";
import type { RouteContext } from "./table.ts";

const bots = [{ id: "sales", threadId: "t-sales", section: "Sales" }, { id: "fin", threadId: "t-fin", section: "Finance" }];
const auth = { kind: "session", scopes: ["client"] } as unknown as RequestAuth;

const grantOf = (departments: ReadonlySet<string> | null) => (departments ? { departments: new Map([...departments].map((name) => [name, "chat" as const])), bots: new Map<string, "chat">() } : null);

function fixture(departments: ReadonlySet<string> | null) {
  const createChannel = vi.fn((value: unknown) => ({ id: "g1", threadId: "t-g1", ...(value as object) }) as unknown as GroupRecord);
  const handler = createGroupRoutes({
    store: { bot: (id: string) => bots.find((bot) => bot.id === id), group: () => undefined, messagesFor: () => [], patchGroup: () => undefined } as never,
    cloudHome: false,
    visibleFor: () => new VisibleSet(bots, [], { kind: "member", email: "ada@acme.test" }, undefined, undefined, grantOf(departments)),
    actorKey: () => "ada",
    threadStarters: { set() {} },
    createChannel,
    publicGroupState: (record) => record as never,
  });
  const post = async (body: unknown) => {
    const sent: Array<{ status: number; body: any }> = [];
    await handler({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL("http://localhost/api/groups"), path: "/api/groups", method: "POST", auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    return sent[0]!;
  };
  return { post, createChannel };
}

describe("creating a room as a member limited to some departments", () => {
  it("refuses a room in a department outside the grant, with 403, and creates nothing", async () => {
    const { post, createChannel } = fixture(new Set(["Sales"]));
    expect((await post({ memberIds: ["sales"], name: "R", section: "Finance" })).status).toBe(403);
    expect((await post({ memberIds: ["sales"], name: "R" })).status).toBe(403);
    expect(createChannel).not.toHaveBeenCalled();
  });

  it("creates a room in a granted department", async () => {
    const { post, createChannel } = fixture(new Set(["Sales"]));
    expect((await post({ memberIds: ["sales"], name: "R", section: "Sales" })).status).toBe(201);
    expect(createChannel).toHaveBeenCalledTimes(1);
  });

  it("answers a bot of another department like a bot that does not exist", async () => {
    const { post } = fixture(new Set(["Sales"]));
    const hidden = await post({ memberIds: ["fin"], name: "R", section: "Sales" });
    expect(hidden).toEqual({ status: 400, body: { error: "unknown channel member: fin" } });
  });

  it("changes nothing for a member with no grant", async () => {
    const { post } = fixture(null);
    expect((await post({ memberIds: ["fin"], name: "R", section: "Finance" })).status).toBe(201);
  });
});
