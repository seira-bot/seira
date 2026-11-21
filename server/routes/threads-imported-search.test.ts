import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { closeMessageDb, closeMessageSearch } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";
import { appendImportedMessages, createImportedThreads, type ImportedMessageInput } from "../store-imported.ts";

const appendOne = (store: Store, threadId: string, messages: ImportedMessageInput[], activeLeafId: string | null) =>
  appendImportedMessages(store, [{ threadId, messages, activeLeafId }]);

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await closeMessageSearch();
  closeMessageDb();
});

async function serve(store: Store): Promise<string> {
  const deps = {
    store, viewerFor: () => ({}),
    visibleTo: () => ({ everything: true, bot: () => true, group: () => true, thread: () => true, sections: () => [] }),
    hostedWorkspace: false, sessionCookie: "seira_session", sessions: {},
    loopback: { trust: "owner", localBrowsers: true }, lendingEnabled: () => false,
    workspaceAccess: () => null, desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined,
  } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Hit = { threadId: string; source?: string; task?: string; onActivePath: boolean };

it("search finds imported archive", async () => {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "plain zanzibar note" });
  createImportedThreads(store, bot.id, [{ threadId: "imp-a", title: "Old chat", createdAt: 1, updatedAt: 2, imported: { kind: "chatgpt", label: "ChatGPT export" } }]);
  appendOne(store, "imp-a", [{ id: "u1", parentId: null, role: "user", text: "imported zanzibar memory", at: 5 }], "u1");
  const base = await serve(store);

  const res = await fetch(`${base}/api/search?q=zanzibar`);
  expect(res.status).toBe(200);
  const { hits } = await res.json() as { hits: Hit[] };
  const imported = hits.find((hit) => hit.threadId === "imp-a");
  const normal = hits.find((hit) => hit.threadId === bot.threadId);
  expect(imported).toMatchObject({ source: "ChatGPT export", task: "Old chat", onActivePath: true });
  expect(normal).toBeDefined();
  expect(normal).not.toHaveProperty("source");
});
