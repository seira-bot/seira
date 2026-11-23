import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
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
    store, maxBots: 100, assertComputerChangeIdle: () => {}, wireBot: (bot) => bot as never,
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

  beforeEach(() => {
    filed.length = 0;
  });

  it("files an Auto bot and a bot with its own computer into a department", async () => {
    expect((await post(phone, { name: "Studio", botIds: ["auto"] })).status).toBe(200);
    expect((await post(phone, { name: "Studio", botIds: ["pinned"] })).status).toBe(200);
    expect(filed).toEqual([[["auto"], "Studio"], [["pinned"], "Studio"]]);
  });
});
