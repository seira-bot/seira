// Where a new bot works when nothing names a place: the route takes the place newBotComputer gives (This computer on the
// desktop app), while a request, the New bot defaults, Approve for me, or a server without it keep their own.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_SUCH_BOT } from "../../shared/bot-read.ts";
import type { WireBot } from "../../shared/wire.ts";
import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { memberBotCreateViolation, type RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import { createBotCreateRoutes, type BotCreateRouteDeps } from "./bots-create.ts";
import { PASS, type RouteContext } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function fixture(options: { newBotComputer?: BotCreateRouteDeps["newBotComputer"]; cfg?: Partial<AppConfig>; team?: BotCreateRouteDeps["team"]; afterCreate?: (bot: BotRecord) => void; maxWorkspaceBots?: number } = {}) {
  const store = new Store(() => sonnet);
  const asked: ModelSelection[] = [];
  /** Conversations a person's audience no longer reaches: the fixture has no Team Cloud audiences of its own. */
  const hiddenThreads = new Set<string>();
  const deps = {
    store,
    cfg: { ...options.cfg } as AppConfig,
    presetStore: { resolve: () => null },
    orgInstallStatuses: () => new Map(),
    hostedWorkspace: false,
    hostedFullAccessRefusal: "",
    desktopManaged: true,
    maxWorkspaceBots: options.maxWorkspaceBots ?? 100,
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
    // The same set the read routes use: built from the bots as they are now, for whoever asks.
    visibleTo: (auth: RequestAuth) => {
      const viewer: Viewer = auth.kind === "session" && auth.session.membershipAuthority === "team" ? { kind: "member", email: auth.session.email } : { kind: "all" };
      const set = new VisibleSet(store.bots as never, store.groups as never, viewer);
      return Object.assign(set, { thread: (threadId: string) => !hiddenThreads.has(threadId) && VisibleSet.prototype.thread.call(set, threadId) });
    },
    ...(options.afterCreate ? { personaliseSetupCard: options.afterCreate } : {}),
    ...(options.team ? { team: options.team } : {}),
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
  return { create, send, store, asked, hiddenThreads };
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

describe("a client that sends a creation again after a lost answer", () => {
  const KEY = "retry-key-0000001";
  const member = (email: string) =>
    ({ kind: "session", via: "bearer", scopes: ["client"], session: { id: `s-${email}`, label: "Member", scopes: ["client"], email, membershipAuthority: "team" } }) as unknown as RequestAuth;
  const team = { name: "Fixture Team", people: { has: () => true } };

  it("makes the bot once: the same retry key sent again gets the same bot and makes no second one", async () => {
    const fx = fixture();
    const before = fx.store.bots.length;
    const first = await fx.send({ name: "Ada", retryKey: KEY });
    expect(first.status).toBe(201);
    const again = await fx.send({ name: "Ada", retryKey: KEY });
    expect(again.status).toBe(200);
    expect(again.body.bot.id).toBe(first.body.bot.id);
    expect(fx.store.bots).toHaveLength(before + 1);
  });

  it("makes one bot when the same key is sent again while the first request is still being made", async () => {
    const fx = fixture();
    const before = fx.store.bots.length;
    const [first, second] = await Promise.all([fx.send({ name: "Ada", retryKey: KEY }), fx.send({ name: "Ada", retryKey: KEY })]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.bot.id).toBe(second.body.bot.id);
    expect(fx.store.bots).toHaveLength(before + 1);
  });

  it("never takes the id from the request: the server makes it, and a retry key is no setting", async () => {
    const fx = fixture();
    const made = await fx.create({ name: "Ada", retryKey: KEY });
    expect(made.id).not.toContain(KEY);
    expect((made as unknown as Record<string, unknown>).retryKey).toBeUndefined();
    expect(fx.store.messagesFor(made.threadId)).toHaveLength(1);
  });

  it("refuses a retry key that is not 16 to 128 letters, digits, - and _", async () => {
    const fx = fixture();
    const before = fx.store.bots.length;
    for (const retryKey of ["short", 7, "has a space in it 0000", "x".repeat(129)]) {
      expect((await fx.send({ name: "Ada", retryKey })).status, String(retryKey)).toBe(400);
    }
    expect(fx.store.bots).toHaveLength(before);
  });

  it("replays only for the member who sent the key: another member gets a bot of their own and learns nothing of the first", async () => {
    const fx = fixture({ team });
    const ada = member("ada@example.test");
    const bea = member("bea@example.test");
    const before = fx.store.bots.length;
    const first = await fx.send({ name: "Private plan", retryKey: KEY }, ada);
    expect(first.status).toBe(201);
    const stranger = await fx.send({ name: "Bea's bot", retryKey: KEY }, bea);
    expect(stranger.status).toBe(201);
    expect(stranger.body.bot.id).not.toBe(first.body.bot.id);
    expect(stranger.body.bot.threadId).not.toBe(first.body.bot.threadId);
    expect(stranger.body.bot.name).toBe("Bea's bot");
    expect(JSON.stringify(stranger.body)).not.toContain(first.body.bot.id);
    expect(fx.store.bots).toHaveLength(before + 2);
    expect(fx.store.bot(stranger.body.bot.id)?.createdBy).toBe("bea@example.test");
  });

  it("makes exactly one bot when the original member retries, whatever another member sent in between", async () => {
    const fx = fixture({ team });
    const ada = member("ada@example.test");
    const before = fx.store.bots.length;
    const first = await fx.send({ name: "Ada's bot", retryKey: KEY }, ada);
    await fx.send({ name: "Bea's bot", retryKey: KEY }, member("bea@example.test"));
    const again = await fx.send({ name: "Ada's bot", retryKey: KEY }, member("ADA@example.test"));
    expect(again.status).toBe(200);
    expect(again.body.bot.id).toBe(first.body.bot.id);
    expect(fx.store.bots.filter((bot) => bot.createdBy === "ada@example.test")).toHaveLength(1);
    expect(fx.store.bots).toHaveLength(before + 2);
  });

  it("answers a member's unknown, taken or foreign ids the same way: the id of a bot is not a thing to probe", async () => {
    const fx = fixture({ team });
    const private1 = await fx.create({ name: "Hidden" });
    for (const body of [{ name: "Probe", id: private1.id }, { name: "Probe", id: private1.threadId }, { name: "Probe", id: "never-made-0001" }]) {
      const out = await fx.send(body, member("bea@example.test"));
      expect(out.status).toBe(403);
      expect(out.body).toEqual({ error: 'forbidden: "id" is an admin\'s to set' });
    }
  });

  it("refuses a retry for a bot the member may no longer see, with the refusal of a missing bot, and makes no other bot", async () => {
    const fx = fixture({ team });
    const ada = member("ada@example.test");
    const first = await fx.send({ name: "Private plan", retryKey: KEY }, ada);
    expect(first.status).toBe(201);
    // An admin took the bot back: it is no longer shared with the member who made it.
    fx.store.patchBot(first.body.bot.id, { visibility: "admins" });
    const before = fx.store.bots.length;
    const again = await fx.send({ name: "Private plan", retryKey: KEY }, ada);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: NO_SUCH_BOT });
    expect(JSON.stringify(again.body)).not.toContain("Private plan");
    expect(fx.store.bots).toHaveLength(before);
  });

  it("sends a retry no conversation the member's audience does not reach", async () => {
    const fx = fixture({ team });
    const ada = member("ada@example.test");
    const first = await fx.send({ name: "Ada's bot", retryKey: KEY }, ada);
    expect(first.body.bot.messages.length).toBeGreaterThan(0);
    fx.hiddenThreads.add(first.body.bot.threadId);
    const again = await fx.send({ name: "Ada's bot", retryKey: KEY }, ada);
    expect(again.status).toBe(200);
    expect(again.body.bot.messages).toEqual([]);
    expect(again.body.bot.activeLeafId).toBeNull();
    expect(fx.store.bots.filter((bot) => bot.createdBy === "ada@example.test")).toHaveLength(1);
  });

  it("checks again for a retry that waited on a creation which finished meanwhile", async () => {
    const hide = (bot: BotRecord) => { fx.store.patchBot(bot.id, { visibility: "admins" }); };
    const fx = fixture({ team, afterCreate: hide });
    const ada = member("ada@example.test");
    const before = fx.store.bots.length;
    const [first, second] = await Promise.all([fx.send({ name: "Ada's bot", retryKey: KEY }, ada), fx.send({ name: "Ada's bot", retryKey: KEY }, ada)]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(404);
    expect(second.body).toEqual({ error: NO_SUCH_BOT });
    expect(fx.store.bots).toHaveLength(before + 1);
  });

  it("answers a retry with its bot, not a full workspace, when the first request took the last free place", async () => {
    const fx = fixture({ maxWorkspaceBots: 1 });
    const [first, second] = await Promise.all([fx.send({ name: "Last place", retryKey: KEY }), fx.send({ name: "Last place", retryKey: KEY })]);
    expect(first.status).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.bot.id).toBe(first.body.bot.id);
    expect(fx.store.bots).toHaveLength(1);
    // A different key still meets the limit.
    expect((await fx.send({ name: "Another", retryKey: "other-retry-key-01" })).status).toBe(409);
  });

  it("is allowed to a Team Cloud member, who still may not name an id, a conversation id or a setting that is an admin's", () => {
    expect(memberBotCreateViolation({ name: "Ada", retryKey: KEY })).toBeNull();
    expect(memberBotCreateViolation({ name: "Ada", id: KEY })).toBe("id");
    expect(memberBotCreateViolation({ name: "Ada", retryKey: KEY, threadId: "thread-0001" })).toBe("threadId");
    expect(memberBotCreateViolation({ name: "Ada", retryKey: KEY, computer: "local" })).toBe("computer");
  });

  it("does not make a paired phone's request an admin's setting", async () => {
    const fx = fixture();
    const phone = { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s1", label: "Device", scopes: ["admin", "client"], pairedDevice: true } } as unknown as RequestAuth;
    expect((await fx.send({ name: "Ada", retryKey: KEY }, phone)).status).toBe(201);
  });
});
