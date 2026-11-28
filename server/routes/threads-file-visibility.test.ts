import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENTS_DIR } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store, threadVisible: boolean): Promise<string> {
  const visible = { everything: false, bot: () => threadVisible, group: () => threadVisible, thread: () => threadVisible };
  const deps = { store, viewerFor: () => ({}), visibleTo: () => visible, workspaceAccess: () => null,
    desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined } as unknown as ThreadRouteDeps;
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

function attachedFile(store: Store) {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const file = join(ATTACHMENTS_DIR, "payroll.csv");
  writeFileSync(file, "name,salary\nAlice,100\n");
  const bot = store.createBot({ name: "Finance" }, { seedMessages: false });
  const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `<attached-file path="${file}" name="payroll.csv" />` });
  return { file, url: `/api/threads/${bot.threadId}/messages/${message.id}/file` };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/threads/:threadId/messages/:messageId/file", () => {
  it("does not serve a file from a conversation the viewer cannot see", async () => {
    const store = new Store(() => sonnet);
    const { file, url } = attachedFile(store);
    const base = await serve(store, false);

    for (const body of [{ path: file }, { path: file, media: true }]) {
      const res = await post(base, url, body);
      const text = await res.text();
      expect(text).not.toContain("Alice,100");
      expect(res.status).toBe(404);
      expect(JSON.parse(text)).toEqual({ error: "no such conversation" });
    }
    const preview = await fetch(`${base}${url}?preview=1&ref=0`);
    expect(preview.status).toBe(404);
    expect(await preview.json()).toEqual({ error: "no such conversation" });
  });

  it("answers a hidden conversation exactly as one that does not exist", async () => {
    const store = new Store(() => sonnet);
    const { file, url } = attachedFile(store);
    const base = await serve(store, false);

    const hidden = await post(base, url.replace(/messages\/[\w-]+/, "messages/no-such-message"), { path: file });
    const missing = await post(base, "/api/threads/no-such-thread/messages/no-such-message/file", { path: file });
    expect([hidden.status, await hidden.json()]).toEqual([missing.status, await missing.json()]);
  });

  it("still serves the file to a viewer who can see the conversation", async () => {
    const store = new Store(() => sonnet);
    const { file, url } = attachedFile(store);
    const base = await serve(store, true);

    const res = await post(base, url, { path: file });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alice,100");
  });
});
