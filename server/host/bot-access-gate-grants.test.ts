import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { VisibleSet, type ResolvedGrant } from "../bot-visibility.ts";
import { readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotAccessGate, createBotAccessHost } from "./bot-access-gate.ts";

const ADA = "ada@acme.test";
const bots = [
  { id: "sales", threadId: "t-sales", section: "Sales" },
  { id: "fin", threadId: "t-fin", section: "Finance" },
];
const auth: RequestAuth = {
  kind: "session", via: "bearer", scopes: ["client"],
  session: { id: "ada", email: ADA, tokenHash: "0".repeat(64), label: "Ada", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: 1 },
};
const grantOf = (departments: Record<string, "view" | "chat">, botItems: Record<string, "view" | "chat"> = {}): ResolvedGrant => ({ departments: new Map(Object.entries(departments)), bots: new Map(Object.entries(botItems)) });
const visibleFor = (grant: ResolvedGrant | null) => new VisibleSet(bots, [{ id: "room", threadId: "t-room", memberIds: ["sales", "fin"], section: "Sales" }], { kind: "member", email: ADA }, undefined, undefined, grant);
const gate = createBotAccessGate({
  botName: (id) => (id === "sales" ? "Sales bot" : "Finance bot"),
  roomBots: (id) => (id === "room" ? ["sales", "fin"] : undefined),
  threadOwner: (threadId) => (threadId === "t-sales" ? { bot: "sales" } : threadId === "t-fin" ? { bot: "fin" } : undefined),
  routine: (id) => (id === "r-fin" ? { botId: "fin" } : undefined),
  run: () => undefined,
  routineWriter: () => undefined,
});
const ask = (visible: VisibleSet, method: string, path: string) => gate(new PassThrough() as unknown as IncomingMessage, auth, method, path, visible);
const viewOnly = (bot: string) => ({ errorKey: "serverError.bot.viewOnly", errorParams: { bot } });

describe("the level gate off a Team Cloud", () => {
  const view = visibleFor(grantOf({ Sales: "chat" }, { fin: "view" }));

  it("refuses a write to a bot that the grant gives as view, and lets a read through (AC-07)", () => {
    expect(ask(view, "POST", "/api/bots/fin/messages")).toMatchObject(viewOnly("Finance bot"));
    expect(ask(view, "POST", "/api/bots/fin/tasks")).toMatchObject(viewOnly("Finance bot"));
    expect(ask(view, "POST", "/api/threads/t-fin/respond")).toMatchObject(viewOnly("Finance bot"));
    expect(ask(view, "POST", "/api/routines")).toBeNull();
    expect(ask(view, "GET", "/api/bots/fin")).toBeNull();
    expect(ask(view, "GET", "/api/threads/t-fin/messages")).toBeNull();
    expect(ask(view, "POST", "/api/bots/fin/read")).toBeNull();
  });

  it("refuses a change to a routine of a view bot, which needed edit on a Team Cloud (AC-07)", () => {
    expect(ask(view, "PATCH", "/api/routines/r-fin")).toMatchObject(viewOnly("Finance bot"));
    expect(ask(view, "DELETE", "/api/routines/r-fin")).toMatchObject(viewOnly("Finance bot"));
  });

  it("refuses a write in a room that holds a view bot (AC-07)", () => {
    expect(ask(view, "POST", "/api/groups/room/messages")).toMatchObject(viewOnly("Finance bot"));
  });

  it("lets a write to a bot that the grant gives as chat through, edit-level routes included", () => {
    expect(ask(view, "POST", "/api/bots/sales/messages")).toBeNull();
    expect(ask(view, "POST", "/api/bots/sales/tasks")).toBeNull();
    expect(ask(view, "PATCH", "/api/routines/r-sales")).toBeNull();
  });

  it("refuses a request body that names a view bot", async () => {
    const stream = new PassThrough();
    const result = gate(stream as unknown as IncomingMessage, auth, "POST", "/api/routines", view);
    expect(result).toBeNull();
    const body = readBody(stream as unknown as IncomingMessage);
    stream.end(JSON.stringify({ botId: "fin" }));
    await expect(body).rejects.toMatchObject({ status: 403, errorKey: "serverError.bot.viewOnly" });
  });

  it("passes a member whose grant has only chat items, and a member with no grant, as before", () => {
    for (const visible of [visibleFor(grantOf({ Sales: "chat" }, { fin: "chat" })), visibleFor(null)]) {
      expect(ask(visible, "POST", "/api/bots/fin/messages")).toBeNull();
      expect(ask(visible, "PATCH", "/api/routines/r-fin")).toBeNull();
    }
  });

  it("gives the higher level when a bot is named by its department and by itself", () => {
    const both = visibleFor(grantOf({ Finance: "view" }, { fin: "chat" }));
    expect(ask(both, "POST", "/api/bots/fin/messages")).toBeNull();
  });
});

describe("the level check for a route that reads its bots itself", () => {
  const host = createBotAccessHost({
    visibleFor: () => visibleFor(grantOf({ Sales: "chat" }, { fin: "view" })),
    store: () => ({ bot: (id: string) => bots.find((bot) => bot.id === id) && { name: id }, group: () => undefined, botByThread: () => undefined, messagesFor: () => [] }) as never,
    routines: () => null,
    threadOwner: () => undefined,
    routineWriter: () => undefined,
  });

  it("refuses a view bot for a write and lets a chat bot through", () => {
    expect(host.botsRefusal(auth, ["fin"], "chat")).toMatch(/view/);
    expect(host.botsRefusal(auth, ["sales"], "chat")).toBeNull();
    expect(host.botsRefusal(auth, ["fin"], "view")).toBeNull();
    expect(host.botsRefusal(auth, ["sales"], "edit")).toBeNull();
    expect(host.botsRefusal(auth, ["fin"], "edit")).toMatch(/view/);
  });
});

describe("the setup card check off a Team Cloud", () => {
  const card = (extra: Record<string, unknown>) => ({ requestId: "r1", ...extra });
  const host = (lines: Array<{ card: Record<string, unknown> }>) => createBotAccessHost({
    visibleFor: () => visibleFor(grantOf({}, { sales: "chat" })),
    store: () => ({ bot: (id: string) => bots.find((bot) => bot.id === id) && { id, name: "Sales bot" }, group: () => undefined, botByThread: (threadId: string) => (threadId === "t-sales" ? { id: "sales", name: "Sales bot" } : undefined), messagesFor: () => lines }) as never,
    routines: () => null,
    threadOwner: () => undefined,
    routineWriter: () => undefined,
  });

  it("refuses a card that changes the bot for a member whose grant gives only chat", () => {
    const refused = host([{ card: card({ profileRequest: { name: "Renamed" } }) }]).cardRefusal(auth, "t-sales", "r1");
    expect(refused).toMatch(/^Only people who can edit Sales bot can change this\.$/);
  });

  it("lets a plain options card through", () => {
    expect(host([{ card: card({ options: [{ label: "Yes" }] }) }]).cardRefusal(auth, "t-sales", "r1")).toBeNull();
  });
});
