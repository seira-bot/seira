import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { WireBot } from "../../shared/wire.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import { createBotPatchRoutes, type BotPatchRouteDeps } from "./bot-patch.ts";
import { FOLDER_ACCESS_SET_ELSEWHERE } from "./department-folders.ts";
import type { RouteContext } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
let root = "";
let dataDir = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bot-folder-access-")));
  dataDir = join(root, "data");
  for (const folder of [dataDir, join(root, "docs"), join(root, "other")]) mkdirSync(folder, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function fixture(setElsewhere = false, level: "edit" | "chat" = "chat") {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const deps = {
    store, cfg: {} as AppConfig, requestedTaskBot: () => null, activeVpsThreads: new Set<string>(),
    wireBot: (record: BotRecord) => record as unknown as WireBot, broadcast: () => {}, audienceChanged: () => {},
    assertTeamComputerChangeIdle: () => {}, routines: () => null, levelOf: () => level,
    mainThreadTasks: (botId: string) => store.tasks(botId), activeGroupTurnForBot: () => null,
    folderAccess: { dataDir, home: root, setElsewhere: () => setElsewhere },
  } as unknown as BotPatchRouteDeps;
  const handler = createBotPatchRoutes(deps);
  const patch = async (body: Record<string, unknown>, auth: RequestAuth = { kind: "loopback", scopes: ["admin"] } as RequestAuth) => {
    const sent: Array<{ status: number; body: any }> = [];
    await handler({
      req: { headers: {} } as unknown as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://localhost/api/bots/${bot.id}`),
      path: `/api/bots/${bot.id}`, method: "PATCH", auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    return sent[0]!;
  };
  return { store, bot, patch };
}

describe("PATCH /api/bots/:id folderAccess", () => {
  it("lets an admin set a list and stores real paths", async () => {
    const { store, bot, patch } = fixture();
    const link = join(root, "link-docs");
    symlinkSync(join(root, "docs"), link);
    const response = await patch({ folderAccess: { limited: true, folders: [{ path: link, write: true }] } });
    expect(response.status).toBe(200);
    expect(store.bot(bot.id)?.folderAccess).toEqual({ limited: true, folders: [{ path: join(root, "docs"), write: true }] });
  });

  it("removes the field on null", async () => {
    const { store, bot, patch } = fixture();
    await patch({ folderAccess: { limited: true, folders: [] } });
    expect(store.bot(bot.id)?.folderAccess).toBeDefined();
    expect((await patch({ folderAccess: null })).status).toBe(200);
    expect(store.bot(bot.id)?.folderAccess).toBeUndefined();
  });

  it("answers 400 with the refusal for a bad path and stores nothing", async () => {
    const { store, bot, patch } = fixture();
    const response = await patch({ folderAccess: { limited: true, folders: [{ path: join(root, "nope"), write: false }] } });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "That folder isn't on this computer.", refusal: "missing", path: join(root, "nope") });
    expect(store.bot(bot.id)?.folderAccess).toBeUndefined();
  });

  it("gives a team editor and a plain client 403", async () => {
    const body = { folderAccess: { limited: false, folders: [] } };
    const editor = fixture(false, "edit");
    const member = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s", label: "L", scopes: ["client"] } } as unknown as RequestAuth;
    const refused = await editor.patch(body, member);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/folderAccess/);
    expect((await fixture().patch(body, member)).status).toBe(403);
    expect(editor.store.bot(editor.bot.id)?.folderAccess).toBeUndefined();
  });

  it("answers 409 on a Team Cloud or hosted workspace", async () => {
    const { store, bot, patch } = fixture(true);
    expect(await patch({ folderAccess: { limited: true, folders: [] } })).toEqual({ status: 409, body: { error: FOLDER_ACCESS_SET_ELSEWHERE } });
    expect(store.bot(bot.id)?.folderAccess).toBeUndefined();
  });
});
