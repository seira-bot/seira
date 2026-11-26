// The relocation guard's scan is the only VPS call this route makes; the mocked scan stands in for SSH
// and lets each test mutate the store mid-scan deterministically.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorScopes } from "../../shared/connector-scopes.ts";
import type { WireBot } from "../../shared/wire.ts";
import { VPS_BOT_ALIAS_CHANGE_ERROR, VPS_BOT_ALIAS_LIFECYCLE_ERROR, VPS_BOT_ALIAS_RESOURCES_ERROR } from "../cloud-backend.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import type { ManagedVpsInventory } from "../vps-computer.ts";
import { createBotPatchRoutes, type BotPatchRouteDeps } from "./bot-patch.ts";
import { PASS, type RouteContext } from "./table.ts";

vi.mock("../vps-computer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vps-computer.ts")>();
  return { ...actual, listManagedVpsComputers: vi.fn(), vpsLifecycleBusy: vi.fn() };
});

const scan = vi.mocked(vps.listManagedVpsComputers);
const lifecycleBusy = vi.mocked(vps.vpsLifecycleBusy);
const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

const emptyInventory = (): ManagedVpsInventory => ({
  configured: true,
  available: true,
  vpsAliases: ["production-vps"],
  problem: null,
  instances: [],
});

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  scan.mockReset();
  scan.mockResolvedValue(emptyInventory());
  lifecycleBusy.mockReset();
  lifecycleBusy.mockReturnValue(false);
});

function fixture(extra: Partial<BotPatchRouteDeps> = {}) {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const cfg = { vps: { sshAlias: "production-vps" } } as AppConfig;
  const activeVpsThreads = new Set<string>();
  const privateThreads = new Set<string>();
  // Only what a vpsAlias patch touches; any other dependency is absent, and a route that reached for one would throw.
  const deps = {
    store,
    cfg,
    requestedTaskBot: () => null,
    activeVpsThreads,
    wireBot: (record: BotRecord) => record as unknown as WireBot,
    broadcast: () => {},
    audienceChanged: () => {},
    assertComputerChangeIdle: () => {},
    routines: () => null,
    // A member's session may chat with this bot: the level that still can't move it or change what it may do.
    levelOf: () => "chat",
    mainThreadTasks: (botId: string) => store.tasks(botId).filter((task) => !privateThreads.has(task.threadId)),
    activeGroupTurnForBot: () => null,
    ...extra,
  } as unknown as BotPatchRouteDeps;
  const handler = createBotPatchRoutes(deps);
  const patch = async (botId: string, body: Record<string, unknown>, as: { auth?: RequestAuth; headers?: Record<string, string> } = {}) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: as.headers ?? {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/bots/${botId}`),
      path: `/api/bots/${botId}`,
      method: "PATCH",
      auth: as.auth ?? ({ kind: "loopback", scopes: ["admin"] } as RequestAuth),
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { store, bot, activeVpsThreads, privateThreads, patch };
}

describe("PATCH /api/bots/:id vpsAlias relocation guard", () => {
  it("skips the guard when pinning a bot to the host it already uses", async () => {
    const { bot, patch } = fixture();

    const pinned = await patch(bot.id, { vpsAlias: "production-vps" });

    expect(pinned.status).toBe(200);
    expect(pinned.body.bot.vpsAlias).toBe("production-vps");
    expect(scan).not.toHaveBeenCalled();
  });

  it("skips the guard when clearing an override equal to the default", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { vpsAlias: "production-vps" });

    const cleared = await patch(bot.id, { vpsAlias: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.vpsAlias).toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
  });

  it("still scans a real move and refuses a busy bot before scanning", async () => {
    const { store, bot, patch } = fixture();

    const moved = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(moved.status).toBe(200);
    expect(moved.body.bot.vpsAlias).toBe("gamma-vps");
    expect(moved.body.notice).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]?.[0]).toEqual({ vps: { sshAlias: "production-vps" } });

    store.patchBot(bot.id, { busy: true });
    const refused = await patch(bot.id, { vpsAlias: "delta-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });

  it("moves a bot off a server that cannot be reached, and says what may be left there", async () => {
    const { store, bot, patch } = fixture();
    scan.mockResolvedValue({
      ...emptyInventory(),
      available: false,
      problem: "Docker over SSH could not list managed computers on production-vps: ssh: Could not resolve hostname production-vps",
    });

    const moved = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
    expect(moved.body.notice).toContain("production-vps could not be reached");
    expect(moved.body.notice).toContain(`docker -H ssh://production-vps rm -f ${vps.vpsContainerName(bot.id)}`);
  });

  it("never lets a member's session or a paired phone choose a bot's server", async () => {
    const { store, bot, patch } = fixture();
    const member = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s", label: "Laptop", scopes: ["client"] } } as unknown as RequestAuth;

    const fromMember = await patch(bot.id, { vpsAlias: "gamma-vps" }, { auth: member });
    const fromPhone = await patch(bot.id, { vpsAlias: "gamma-vps" }, { headers: { "x-seira-companion": "1" } });

    expect(fromMember.status).toBe(403);
    expect(fromMember.body.error).toMatch(/not "vpsAlias"/);
    expect(fromPhone.status).toBe(403);
    expect(fromPhone.body.error).toMatch(/not "vpsAlias"/);
    expect(scan).not.toHaveBeenCalled();
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("makes Cloud the person's own VPS whichever client chose it, and leaves other places alone", async () => {
    const { bot, store, patch } = fixture();
    expect((await patch(bot.id, { computer: "cloud" })).status).toBe(200);
    expect([store.bot(bot.id)?.computer, store.bot(bot.id)?.cloudBackend]).toEqual(["cloud", "vps"]);
    expect((await patch(bot.id, { computer: "cloud", cloudBackend: "box" })).status).toBe(200);
    expect(store.bot(bot.id)?.cloudBackend).toBe("vps");
    expect((await patch(bot.id, { computer: "off" })).status).toBe(200);
    expect(store.bot(bot.id)?.computer).toBe("off");
  });

  it("still refuses the move while the bot's computer lives on the old server", async () => {
    const { bot, patch } = fixture();
    scan.mockResolvedValue({
      ...emptyInventory(),
      instances: [{
        name: vps.vpsContainerName(bot.id),
        state: "running",
        vpsAlias: "production-vps",
        ownerBotId: bot.id,
        ownerName: bot.name,
        orphaned: false,
        inUse: false,
      }],
    });

    const blocked = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe(VPS_BOT_ALIAS_RESOURCES_ERROR);
  });

  it("refuses while a VPS computer action is still running, before or during the scan", async () => {
    const { store, bot, patch } = fixture();
    lifecycleBusy.mockReturnValue(true);

    const before = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(before.status).toBe(409);
    expect(before.body.error).toBe(VPS_BOT_ALIAS_LIFECYCLE_ERROR);
    expect(scan).not.toHaveBeenCalled();

    lifecycleBusy.mockReturnValue(false);
    scan.mockImplementation(async () => {
      lifecycleBusy.mockReturnValue(true);
      return emptyInventory();
    });
    const during = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(during.status).toBe(409);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("rescans when the stored alias changes mid-scan", async () => {
    const { store, bot, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { vpsAlias: "delta-vps" });
      return emptyInventory();
    });

    const moved = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(moved.status).toBe(200);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });

  it("refuses when a turn starts mid-scan and keeps the stored alias", async () => {
    const { store, bot, activeVpsThreads, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { busy: true });
      activeVpsThreads.add(bot.id);
      return emptyInventory();
    });

    const refused = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("gives up after three unstable attempts", async () => {
    const { store, bot, patch } = fixture();
    let flip = false;
    scan.mockImplementation(async () => {
      flip = !flip;
      store.patchBot(bot.id, { vpsAlias: flip ? "delta-vps" : "epsilon-vps" });
      return emptyInventory();
    });

    const refused = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(scan).toHaveBeenCalledTimes(3);
  });
});

describe("PATCH /api/bots/:id toolsOff", () => {
  it("stores known groups once each in one order, clears them with null or an empty list, and refuses anything else", async () => {
    const { store, bot, patch } = fixture();
    expect((await patch(bot.id, { toolsOff: ["pages", "meetings", "pages"] })).status).toBe(200);
    expect(store.bot(bot.id)?.toolsOff).toEqual(["meetings", "pages"]);
    const refused = await patch(bot.id, { toolsOff: ["browser"] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("toolsOff must be a list of meetings, data, pages, images, email");
    expect((await patch(bot.id, { toolsOff: "meetings" })).status).toBe(400);
    expect(store.bot(bot.id)?.toolsOff).toEqual(["meetings", "pages"]);
    expect((await patch(bot.id, { toolsOff: [] })).status).toBe(200);
    expect(store.bot(bot.id)?.toolsOff).toBeUndefined();
    await patch(bot.id, { toolsOff: ["data"] });
    expect((await patch(bot.id, { toolsOff: null })).status).toBe(200);
    expect(store.bot(bot.id)?.toolsOff).toBeUndefined();
  });
});

describe("PATCH /api/bots/:id liveVoice", () => {
  it("gives one bot its own Live call voice, leaves the others on the app's, clears it, and refuses a voice that is not a Live one", async () => {
    const { store, bot, patch } = fixture();
    const other = store.createBot({ name: "Echo" });
    expect((await patch(bot.id, { liveVoice: "cedar" })).status).toBe(200);
    expect(store.bot(bot.id)?.liveVoice).toBe("cedar");
    expect(store.bot(other.id)?.liveVoice).toBeUndefined();
    expect((await patch(bot.id, { liveVoice: "Kore" })).status).toBe(200);
    expect(store.bot(bot.id)?.liveVoice).toBe("Kore");
    for (const liveVoice of ["robot", "kore", 7, "cedar ".repeat(3)]) {
      const refused = await patch(bot.id, { liveVoice });
      expect(refused.status, String(liveVoice)).toBe(400);
      expect(refused.body.error).toBe("liveVoice must be a GPT-Live or Gemini Live voice, or empty");
    }
    expect(store.bot(bot.id)?.liveVoice).toBe("Kore");
    expect((await patch(bot.id, { liveVoice: "" })).status).toBe(200);
    expect(store.bot(bot.id)?.liveVoice).toBeUndefined();
    await patch(bot.id, { liveVoice: "ash" });
    expect((await patch(bot.id, { liveVoice: null })).status).toBe(200);
    expect(store.bot(bot.id)?.liveVoice).toBeUndefined();
  });
});

describe("PATCH /api/bots/:id callSpeed and callLanguage", () => {
  it("saves both, returns them on the bot, and clears them with null or an empty string", async () => {
    const { store, bot, patch } = fixture();
    const saved = await patch(bot.id, { callSpeed: 1.25, callLanguage: "id" });
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject({ callSpeed: 1.25, callLanguage: "id" });
    expect(store.bot(bot.id)).toMatchObject({ callSpeed: 1.25, callLanguage: "id" });
    expect((await patch(bot.id, { callSpeed: null, callLanguage: "" })).status).toBe(200);
    expect(store.bot(bot.id)?.callSpeed).toBeUndefined();
    expect(store.bot(bot.id)?.callLanguage).toBeUndefined();
    await patch(bot.id, { callLanguage: "auto" });
    expect(store.bot(bot.id)?.callLanguage).toBe("auto");
  });
  it("refuses a speed outside 0.5 to 2 or not a number, and an unlisted language, keeping the saved value", async () => {
    const { store, bot, patch } = fixture();
    await patch(bot.id, { callSpeed: 1.5, callLanguage: "fr" });
    for (const callSpeed of [0.4, 2.1, "1", true, Number.NaN]) expect((await patch(bot.id, { callSpeed })).status, String(callSpeed)).toBe(400);
    for (const callLanguage of ["xx", "FR", 5, "fr-CA"]) expect((await patch(bot.id, { callLanguage })).status, String(callLanguage)).toBe(400);
    expect(store.bot(bot.id)).toMatchObject({ callSpeed: 1.5, callLanguage: "fr" });
  });
  it("tells the live call only when the saved speed changed", async () => {
    const callSpeedChanged = vi.fn();
    const { bot, patch } = fixture({ callSpeedChanged });
    await patch(bot.id, { callSpeed: 1.2 });
    await patch(bot.id, { callSpeed: 1.2 });
    await patch(bot.id, { callSpeed: null });
    expect(callSpeedChanged.mock.calls).toEqual([[bot.id, 1.2], [bot.id, undefined]]);
  });
});

describe("PATCH /api/bots/:id alwaysAllow", () => {
  it("stores the list once each, and refuses a list over the limit instead of cutting it", async () => {
    const { store, bot, patch } = fixture();
    const keys = Array.from({ length: 200 }, (_, i) => `tool_${i}`);
    expect((await patch(bot.id, { alwaysAllow: [...keys, keys[0]] })).status).toBe(200);
    expect(store.bot(bot.id)?.alwaysAllow).toEqual(keys);
    const refused = await patch(bot.id, { alwaysAllow: [...keys, "tool_200"] });
    expect(refused.status).toBe(400);
    expect(refused.body.errorKey).toBe("serverError.bot.alwaysAllowFull");
    expect(store.bot(bot.id)?.alwaysAllow).toEqual(keys);
  });
});

describe("PATCH /api/bots/:id phoneApps", () => {
  it("stores phoneApps and clears it with null", async () => {
    const { store, bot, patch } = fixture();

    const stored = await patch(bot.id, { phoneApps: { calendar: "read", location: "write" } });

    expect(stored.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read", location: "write" });

    const cleared = await patch(bot.id, { phoneApps: null });

    expect(cleared.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });

  it("rejects an unknown capability or grant", async () => {
    const { store, bot, patch } = fixture();
    const error = "phoneApps must be { <calendar|reminders|contacts|location|home|messages>: read | write } or null";

    const unknownApp = await patch(bot.id, { phoneApps: { camera: "read" } });
    const unknownGrant = await patch(bot.id, { phoneApps: { calendar: "admin" } });

    expect(unknownApp.status).toBe(400);
    expect(unknownApp.body.error).toBe(error);
    expect(unknownGrant.status).toBe(400);
    expect(unknownGrant.body.error).toBe(error);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });

  it("treats a raised phone grant as loosening", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { phoneApps: { calendar: "read" } });
    store.patchBot(bot.id, { busy: true });

    const raised = await patch(bot.id, { phoneApps: { calendar: "write" } });
    const added = await patch(bot.id, { phoneApps: { calendar: "read", contacts: "read" } });

    expect(raised.status).toBe(409);
    expect(added.status).toBe(409);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read" });

    const narrowed = await patch(bot.id, { phoneApps: {} });

    expect(narrowed.status).toBe(200);
  });

  it("treats clearing a narrower grant as loosening on any bot, since the default is every app", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { phoneApps: { calendar: "read" } });
    store.patchBot(bot.id, { busy: true });

    const cleared = await patch(bot.id, { phoneApps: null });
    store.patchBot(bot.id, { chiefOfStaff: true });
    const clearedOnChief = await patch(bot.id, { phoneApps: null });

    expect(cleared.status).toBe(409);
    expect(clearedOnChief.status).toBe(409);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read" });
  });

  it("treats switching every app off from the default as tightening", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { busy: true });

    const off = await patch(bot.id, { phoneApps: {} });

    expect(off.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toEqual({});
  });

  it("refuses an archived conversation, which the main-thread resolver skips", async () => {
    const { store, bot, patch } = fixture();
    const archived = store.createTask(bot.id, "Done", false)!;
    store.patchTask(bot.id, archived.threadId, { archivedAt: Date.now() });
    expect((await patch(bot.id, { mainThreadChoice: archived.threadId })).status).toBe(400);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });

  it("refuses a client session and a paired device", async () => {
    const { store, bot, patch } = fixture();

    const client = await patch(bot.id, { phoneApps: { calendar: "write" } }, { auth: { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s-member", email: "member@example.com", label: "Front desk" } } as unknown as RequestAuth });
    const paired = await patch(bot.id, { phoneApps: { calendar: "write" } }, { headers: { "x-seira-companion": "1" } });

    expect(client.status).toBe(403);
    expect(paired.status).toBe(403);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });
});

describe("PATCH /api/bots/:id while the bot works", () => {
  const owner = { headers: { origin: "http://localhost:5173" } };

  it("saves MCP servers and tool selection for the next turn", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { mcpServers: ["notes"], busy: true });

    const added = await patch(bot.id, { mcpServers: ["notes", "docs"] }, owner);
    const narrowed = await patch(bot.id, { mcpServers: ["docs"] });
    const scoped = await patch(bot.id, { toolScope: { deny: ["mcp:docs:delete"] } });

    expect([added.status, narrowed.status, scoped.status]).toEqual([200, 200, 200]);
    expect(store.bot(bot.id)?.mcpServers).toEqual(["docs"]);
    expect(store.bot(bot.id)?.toolScope).toEqual({ deny: ["mcp:docs:delete"] });
  });

  it("still refuses a local script that widens MCP servers while any bot works", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { mcpServers: ["notes"], busy: true });

    const widened = await patch(bot.id, { mcpServers: ["notes", "docs"] });

    expect(widened.status).toBe(409);
    expect(store.bot(bot.id)?.mcpServers).toEqual(["notes"]);
  });
});

describe("PATCH /api/bots/:id connectorScopes", () => {
  it("refuses a local-API widening while another bot works in a room, and still allows narrowing", async () => {
    let roomBotId = "";
    const { store, bot, patch } = fixture({
      activeGroupTurnForBot: (botId: string) => (botId === roomBotId ? { group: {} as never, threadId: "room-thread" } : null),
    });
    roomBotId = store.createBot({ name: "Room worker" }).id;
    const firstAndSecond: ConnectorScopes = { apps: { gmail: "read" }, accounts: { gmail: ["first", "second"] } };
    const firstOnly: ConnectorScopes = { apps: { gmail: "read" }, accounts: { gmail: ["first"] } };
    store.patchBot(bot.id, { connectorScopes: firstAndSecond });

    const widened = await patch(bot.id, { connectorScopes: { apps: { gmail: "read" }, accounts: { gmail: ["first", "second", "third"] } } });

    expect(widened.status).toBe(409);
    expect(store.bot(bot.id)?.connectorScopes).toEqual(firstAndSecond);

    const narrowed = await patch(bot.id, { connectorScopes: firstOnly });

    expect(narrowed.status).toBe(200);
    expect(store.bot(bot.id)?.connectorScopes).toEqual(firstOnly);
  });

  it("refuses a local-API widening when another bot starts working while the computer change is stopping this one", async () => {
    let otherBotId = "";
    const { store, bot, patch } = fixture({
      interruptAllDirectThreads: async () => { store.patchBot(otherBotId, { busy: true }); },
      routines: () => ({ activeBotRunForBot: () => null }),
    } as unknown as Partial<BotPatchRouteDeps>);
    otherBotId = store.createBot({ name: "Other worker" }).id;
    const firstOnly: ConnectorScopes = { apps: { gmail: "read" }, accounts: { gmail: ["first"] } };
    store.patchBot(bot.id, { computer: "local", connectorScopes: firstOnly });

    const widened = await patch(bot.id, { computer: "off", connectorScopes: { apps: { gmail: "read" }, accounts: { gmail: ["first", "second"] } } });

    expect(widened.status).toBe(409);
    expect(store.bot(bot.id)?.connectorScopes).toEqual(firstOnly);
  });

  it("refuses a local-API narrowing that became a widening after another change while the computer change was stopping this one", async () => {
    let otherBotId = "";
    let botId = "";
    const secondOnly: ConnectorScopes = { apps: { gmail: "read" }, accounts: { gmail: ["second"] } };
    const { store, bot, patch } = fixture({
      interruptAllDirectThreads: async () => {
        store.patchBot(botId, { connectorScopes: secondOnly });
        store.patchBot(otherBotId, { busy: true });
      },
      routines: () => ({ activeBotRunForBot: () => null }),
    } as unknown as Partial<BotPatchRouteDeps>);
    botId = bot.id;
    otherBotId = store.createBot({ name: "Other worker" }).id;
    const firstAndSecond: ConnectorScopes = { apps: { gmail: "read" }, accounts: { gmail: ["first", "second"] } };
    store.patchBot(bot.id, { computer: "local", connectorScopes: firstAndSecond });

    const stale = await patch(bot.id, { computer: "off", connectorScopes: { apps: { gmail: "read" }, accounts: { gmail: ["first"] } } });

    expect(stale.status).toBe(409);
    expect(store.bot(bot.id)?.connectorScopes).toEqual(secondOnly);
  });
});

describe("PATCH /api/bots/:id mainThreadChoice", () => {
  it("stores the conversation the person chose, clears it with null, and refuses a routine run or another bot's thread", async () => {
    const { store, bot, patch } = fixture();
    const chosen = store.createTask(bot.id, "Chosen", false)!;
    const run = store.createTask(bot.id, "Run", false)!;
    store.patchTask(bot.id, run.threadId, { routineRunId: "run-1" });
    const other = store.createBot({ name: "Other" });

    expect((await patch(bot.id, { mainThreadChoice: chosen.threadId })).status).toBe(200);
    expect(store.bot(bot.id)?.mainThreadChoice).toBe(chosen.threadId);

    for (const refused of [run.threadId, other.threadId, "missing", 7]) {
      expect((await patch(bot.id, { mainThreadChoice: refused })).status).toBe(400);
    }
    expect(store.bot(bot.id)?.mainThreadChoice).toBe(chosen.threadId);

    expect((await patch(bot.id, { mainThreadChoice: null })).status).toBe(200);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });

  it("refuses a conversation the main-thread resolver can't pick, the same way as an unknown id", async () => {
    const { store, bot, patch, privateThreads } = fixture();
    const hidden = store.createTask(bot.id, "Private", false)!;
    privateThreads.add(hidden.threadId);
    const refused = await patch(bot.id, { mainThreadChoice: hidden.threadId });
    const unknown = await patch(bot.id, { mainThreadChoice: "missing" });
    expect(refused).toEqual(unknown);
    expect(refused.status).toBe(400);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });

  it("refuses a client session and a paired device", async () => {
    const { store, bot, patch } = fixture();
    const client = await patch(bot.id, { mainThreadChoice: bot.threadId }, { auth: { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s-member", email: "member@example.com", label: "Front desk" } } as unknown as RequestAuth });
    const paired = await patch(bot.id, { mainThreadChoice: bot.threadId }, { headers: { "x-seira-companion": "1" } });
    expect(client.status).toBe(403);
    expect(paired.status).toBe(403);
    expect(store.bot(bot.id)?.mainThreadChoice).toBeUndefined();
  });
});

describe("PATCH /api/bots/:id takes the paired-device limits from the pairing record", () => {
  const PAIRED = /^forbidden: a paired device may change how a bot looks, not "/;
  const session = (scopes: string[], record: Record<string, unknown> = {}) =>
    ({ kind: "session", via: "bearer", scopes, session: { id: "s-device", label: "Device", scopes, ...record } }) as unknown as RequestAuth;
  const phone = (scopes = ["admin", "client"]) => session(scopes, { pairedDevice: true });
  const teamPhone = session(["client"], { email: "ada@example.com", membershipAuthority: "team", teamRole: "member", memberCheckedAt: 1 });
  const companionPhone = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1" } as RequestAuth;

  it("holds a paired phone to the limits when it sends no companion header", async () => {
    const { store, bot, patch } = fixture({ levelOf: () => "edit" } as Partial<BotPatchRouteDeps>);
    for (const as of [phone(), teamPhone, companionPhone]) {
      for (const body of [{ vpsAlias: "gamma-vps" }, { approvalMode: "full" }, { name: "Renamed" }]) {
        const refused = await patch(bot.id, body, { auth: as });
        expect(refused.status, JSON.stringify(body)).toBe(403);
        expect(refused.body.error).toMatch(PAIRED);
      }
    }
    expect(scan).not.toHaveBeenCalled();
    expect(store.bot(bot.id)).toMatchObject({ name: "Scout" });
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
    expect((await patch(bot.id, { pinned: true }, { auth: phone() })).status).toBe(200);
  });

  it("keeps the move to no computer for an admin phone that sends no companion header", async () => {
    const { store, bot, patch } = fixture({
      interruptAllDirectThreads: async () => {},
      routines: () => ({ activeBotRunForBot: () => null }),
    } as unknown as Partial<BotPatchRouteDeps>);
    store.patchBot(bot.id, { computer: "local" });
    const moved = await patch(bot.id, { computer: "off" }, { auth: phone() });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(store.bot(bot.id)?.computer).toBe("off");
    expect((await patch(bot.id, { computer: "off" }, { auth: phone(["client"]) })).status).toBe(403);
  });

  it("never gives a session more because it sends the companion header", async () => {
    const { store, bot, patch } = fixture({ levelOf: () => "view" } as Partial<BotPatchRouteDeps>);
    const viewer = await patch(bot.id, { pinned: true }, { auth: session(["client"]), headers: { "x-seira-companion": "1" } });
    expect(viewer.status).toBe(403);
    expect(viewer.body.error).toBe('forbidden: you can view this bot, not change "pinned"');
    const admin = await patch(bot.id, { vpsAlias: "gamma-vps" }, { auth: session(["admin", "client"]), headers: { "x-seira-companion": "1" } });
    expect(admin.status).toBe(403);
    expect(admin.body.error).toMatch(PAIRED);
    expect(store.bot(bot.id)?.pinned).toBeFalsy();
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("leaves a session with no mark as it was: an admin's still changes anything, a member's only what its level allows", async () => {
    const { store, bot, patch } = fixture();
    const member = await patch(bot.id, { approvalMode: "full" }, { auth: session(["client"]) });
    expect(member.status).toBe(403);
    expect(member.body.error).toMatch(/needs the admin scope/);
    const admin = await patch(bot.id, { vpsAlias: "gamma-vps" }, { auth: session(["admin", "client"]) });
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });
});

describe("PATCH /api/bots/:id github_app grants", () => {
  const scopes = { apps: { github_app: "read" } };

  it("refuses a change from someone who does not own the GitHub connection and stores nothing", async () => {
    const { store, bot, patch } = fixture({ ownsGithubConnection: () => false });

    const refused = await patch(bot.id, { connectorScopes: scopes });

    expect(refused.status).toBe(403);
    expect(store.bot(bot.id)?.connectorScopes).toBeUndefined();
  });

  it("refuses a change when no owner check is wired", async () => {
    const { store, bot, patch } = fixture();

    expect((await patch(bot.id, { connectorScopes: scopes })).status).toBe(403);
    expect(store.bot(bot.id)?.connectorScopes).toBeUndefined();
  });

  it("refuses a Team Cloud editor's per-tool grant for github_app", async () => {
    const { store, bot, patch } = fixture({ ownsGithubConnection: () => false });

    const refused = await patch(bot.id, { connectorTools: { github_app: { tools: "*" } } });

    expect(refused.status).toBe(403);
    expect(store.bot(bot.id)?.connectorTools).toBeUndefined();
  });

  it("lets the owner change the grant", async () => {
    const { store, bot, patch } = fixture({ ownsGithubConnection: () => true });

    const allowed = await patch(bot.id, { connectorScopes: scopes });

    expect(allowed.status).toBe(200);
    expect(store.bot(bot.id)?.connectorScopes).toEqual(scopes);
  });

  it("does not stop a change to another app, or a patch that leaves github_app as it is", async () => {
    const { store, bot, patch } = fixture({ ownsGithubConnection: () => false });

    expect((await patch(bot.id, { connectorScopes: { apps: { gmail: "read" } } })).status).toBe(200);
    expect(store.bot(bot.id)?.connectorScopes).toEqual({ apps: { gmail: "read" } });
  });

  it("refuses a person who did not connect GitHub turning it back on for a bot with GitHub access", async () => {
    const cases: Array<[Partial<BotRecord>, Record<string, unknown>]> = [
      [{ composio: false }, { composio: true }],
      [{ connectorScopes: { apps: { gmail: "read" } } as ConnectorScopes }, { connectorScopes: null }],
      [{ connectorTools: { gmail: { tools: "*" } } }, { connectorTools: null }],
    ];
    for (const [before, body] of cases) {
      const { store, bot, patch } = fixture({ ownsGithubConnection: () => false, githubGrantedTo: () => true });
      store.patchBot(bot.id, before);

      expect((await patch(bot.id, body)).status).toBe(403);
      expect(store.bot(bot.id)).toMatchObject(before);
    }
  });

  it("lets a person who did not connect GitHub turn it off, or turn Composio on for a bot without GitHub access", async () => {
    const off = fixture({ ownsGithubConnection: () => false, githubGrantedTo: () => true });
    expect((await off.patch(off.bot.id, { composio: false })).status).toBe(200);
    expect(off.store.bot(off.bot.id)?.composio).toBe(false);

    const none = fixture({ ownsGithubConnection: () => false, githubGrantedTo: () => false });
    none.store.patchBot(none.bot.id, { composio: false });
    expect((await none.patch(none.bot.id, { composio: true })).status).toBe(200);
    expect(none.store.bot(none.bot.id)?.composio).toBe(true);
  });

  it("lets the owner turn GitHub back on, but not from a local caller while a bot is busy, whatever its Origin", async () => {
    const { store, bot, patch } = fixture({ ownsGithubConnection: () => true, githubGrantedTo: () => true });
    store.patchBot(bot.id, { composio: false });
    const worker = store.createBot({ name: "Worker" });
    store.patchBot(worker.id, { busy: true });

    expect((await patch(bot.id, { composio: true })).status).toBe(409);
    expect((await patch(bot.id, { composio: true }, { headers: { origin: "http://localhost:5173" } })).status).toBe(409);
    expect(store.bot(bot.id)?.composio).toBe(false);
    store.patchBot(worker.id, { busy: false });
    expect((await patch(bot.id, { composio: true })).status).toBe(200);
    expect(store.bot(bot.id)?.composio).toBe(true);
  });

  it("stops the owner-less clearing of a github_app scope too", async () => {
    const { store, bot, patch } = fixture({ ownsGithubConnection: () => false });
    store.patchBot(bot.id, { connectorScopes: scopes as ConnectorScopes });

    const refused = await patch(bot.id, { connectorScopes: null });

    expect(refused.status).toBe(403);
    expect(store.bot(bot.id)?.connectorScopes).toEqual(scopes);
  });
});
