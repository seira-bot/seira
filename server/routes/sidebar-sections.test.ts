import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import type { TeamComputers } from "../team-computers.ts";
import { createSidebarSectionRoutes, storeRefusal } from "./sidebar-sections.ts";
import type { RouteContext } from "./table.ts";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("a department refusal the store words", () => {
  it("carries its key, with the store's English unchanged", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    store.createBot({ name: "Scout", section: "Delivery" });
    const missing = store.deleteSection("Nowhere")!;
    expect(storeRefusal(store.renameSection("Nowhere", "Elsewhere")!)).toEqual(storeRefusal(missing));
    const badName = store.renameSection("Delivery", "Bad\u0001name")!;
    expect(storeRefusal(missing)).toEqual({ error: "No such department", errorKey: "serverError.department.notFound" });
    expect(storeRefusal(badName)).toEqual({
      error: "Department name must be 1 to 60 characters without control characters", errorKey: "serverError.department.nameRule",
    });
  });

  it("stays plain English when the app has no words for it", () => {
    expect(storeRefusal("A team with that name already exists")).toEqual({ error: "A team with that name already exists" });
  });
});

describe("a paired device filing bots", () => {
  const bots = new Map<string, BotRecord>([
    ["auto", { id: "auto", section: "Home" } as BotRecord],
    ["pinned", { id: "pinned", section: "Home", computer: "local" } as BotRecord],
  ]);
  const teamComputers = {
    forSection: (section: string | undefined) => (section === "Studio" ? { id: "studio-pc" } : undefined),
    forBot: (bot: { computer?: string; cloudBackend?: string; section?: string }) =>
      bot.computer === undefined && bot.cloudBackend !== "vps" ? teamComputers.forSection(bot.section) : undefined,
  } as unknown as TeamComputers;
  const filed: Array<[string[], string]> = [];
  const store = {
    sections: ["Home", "Studio"],
    bot: (id: string) => bots.get(id),
    setBotsSection: (ids: string[], name: string) => {
      filed.push([ids, name]);
      return { ok: true, bots: ids.map((id) => bots.get(id)!) };
    },
  } as unknown as Store;
  const handler = createSidebarSectionRoutes({
    store, teamComputers, maxBots: 100, assertTeamComputerChangeIdle: () => {}, wireBot: (bot) => bot as never,
  });
  const post = async (auth: RequestAuth, body: unknown) => {
    const sent: Array<{ status: number; body: any }> = [];
    await handler({
      req: { headers: {} } as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL("http://localhost/api/sidebar-sections"),
      path: "/api/sidebar-sections",
      method: "POST",
      auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    return sent[0]!;
  };
  const phone = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "d1" } as RequestAuth;
  const host = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;

  beforeEach(() => {
    filed.length = 0;
  });

  it("cannot move an Auto bot onto a team computer", async () => {
    const refused = await post(phone, { name: "Studio", botIds: ["auto"] });
    expect(refused.status).toBe(403);
    expect(filed).toEqual([]);
  });

  it("files into a department without a team computer", async () => {
    const filedOk = await post(phone, { name: "Home", botIds: ["auto"] });
    expect(filedOk.status).toBe(200);
    expect(filed).toEqual([[["auto"], "Home"]]);
  });

  it("files a bot that has its own computer into a team department", async () => {
    expect((await post(phone, { name: "Studio", botIds: ["pinned"] })).status).toBe(200);
  });

  it("lets the host computer move an Auto bot onto a team computer", async () => {
    expect((await post(host, { name: "Studio", botIds: ["auto"] })).status).toBe(200);
  });
});
