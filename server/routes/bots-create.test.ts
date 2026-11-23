// Where a new bot works when nothing names a place: the route takes the place newBotComputer gives (This computer on the
// desktop app), while a request, the New bot defaults, Approve for me, or a server without it keep their own.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireBot } from "../../shared/wire.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import { createBotCreateRoutes, type BotCreateRouteDeps } from "./bots-create.ts";
import { PASS, type RouteContext } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function fixture(options: { newBotComputer?: BotCreateRouteDeps["newBotComputer"]; cfg?: Partial<AppConfig> } = {}) {
  const store = new Store(() => sonnet);
  const asked: ModelSelection[] = [];
  const deps = {
    store,
    cfg: { ...options.cfg } as AppConfig,
    presetStore: { resolve: () => null },
    orgInstallStatuses: () => new Map(),
    hostedWorkspace: false,
    hostedFullAccessRefusal: "",
    desktopManaged: true,
    maxWorkspaceBots: 100,
    paused: () => false,
    cloudOwnerKey: null,
    hostedModels: null,
    cloudRoutineAuthors: null,
    routines: () => null,
    storedAvatarExists: () => false,
    defaultSelection: async () => sonnet,
    checkedModelSelection: (raw: unknown) => ({ ok: true, selection: raw as ModelSelection }),
    cloudOwnerSession: () => false,
    wireBot: (record: BotRecord) => record as unknown as WireBot,
    ...(options.newBotComputer ? { newBotComputer: (selection: ModelSelection) => { asked.push(selection); return options.newBotComputer!(selection); } } : {}),
  } as unknown as BotCreateRouteDeps;
  const handler = createBotCreateRoutes(deps);
  const send = async (body: Record<string, unknown>, auth: RequestAuth = { kind: "loopback", scopes: ["admin"] }) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL("http://localhost/api/bots"),
      path: "/api/bots",
      method: "POST",
      auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  const create = async (body: Record<string, unknown>) => {
    const sent = await send(body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    return store.bot(sent.body.bot.id)!;
  };
  return { create, send, store, asked };
}

describe("where a new bot works", () => {
  it("is This computer on the desktop app when nothing names a place, asked for the bot's own model", async () => {
    const fx = fixture({ newBotComputer: () => "local" });
    expect((await fx.create({ name: "Ada" })).computer).toBe("local");
    const other: ModelSelection = { instanceId: "openai-compat", model: "fixture-model" };
    expect((await fx.create({ name: "Bea", modelSelection: other })).computer).toBe("local");
    expect(fx.asked).toEqual([sonnet, other]);
  });

  it("keeps the place a request or the New bot defaults name, Auto included", async () => {
    const fx = fixture({ newBotComputer: () => "local" });
    expect((await fx.create({ name: "Ada", useDefaults: false, settings: { computer: "vm" } })).computer).toBe("vm");
    expect((await fx.create({ name: "Bea", useDefaults: false, settings: { computer: null } })).computer).toBeUndefined();
    const saved = fixture({ newBotComputer: () => "local", cfg: { newBotDefaults: { profile: { computer: "browser" }, memory: {}, skills: [], routines: [] } } as Partial<AppConfig> });
    expect((await saved.create({ name: "Cy" })).computer).toBe("browser");
  });

  it("stays Auto with Approve for me, and wherever newBotComputer names no place (a Cloud, a server, Linux)", async () => {
    const fx = fixture({ newBotComputer: () => "local" });
    expect((await fx.create({ name: "Ada", useDefaults: false, settings: { approvalMode: "auto" } })).computer).toBeUndefined();
    expect((await fixture({ newBotComputer: () => undefined }).create({ name: "Bea" })).computer).toBeUndefined();
    expect((await fixture().create({ name: "Cy" })).computer).toBeUndefined();
  });

  it("works on the person's own VPS when a request or the New bot defaults name Cloud", async () => {
    const fx = fixture();
    const made = await fx.create({ name: "Ada", useDefaults: false, settings: { computer: "cloud" } });
    expect([made.computer, made.cloudBackend]).toEqual(["cloud", "vps"]);
    const saved = fixture({ cfg: { newBotDefaults: { profile: { computer: "cloud" }, memory: {}, skills: [], routines: [] } } as Partial<AppConfig> });
    const other = await saved.create({ name: "Bea" });
    expect([other.computer, other.cloudBackend]).toEqual(["cloud", "vps"]);
    expect((await fx.create({ name: "Cy", useDefaults: false, settings: { computer: "vm" } })).cloudBackend).toBeUndefined();
  });
});

describe("folder access at creation", () => {
  it("is never taken from the request: folders are set afterwards, by an admin, on the folder routes", async () => {
    const folderAccess = { limited: false, folders: [{ path: "/", write: true }] };
    expect((await fixture().create({ name: "Ada", folderAccess })).folderAccess).toBeUndefined();
    await expect(fixture().create({ name: "Ada", settings: { folderAccess } })).rejects.toThrow("unsupported bot field: folderAccess");
  });
});

describe("a new bot from a paired phone", () => {
  const session = (record: Record<string, unknown>) =>
    ({ kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s1", label: "Device", scopes: ["admin", "client"], ...record } }) as unknown as RequestAuth;

  it("gets only who the bot is and how it looks when the phone's session sends no companion header", async () => {
    const fx = fixture();
    const before = fx.store.bots.length;
    const refused = await fx.send({ name: "Ada", computer: "off" }, session({ pairedDevice: true }));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/^forbidden: a paired device may say who a new bot is and how it looks, not "computer"/);
    expect(fx.store.bots).toHaveLength(before);
    expect((await fx.send({ name: "Ada", computer: "off" }, session({}))).status, "an admin's other session").toBe(201);
  });
});
