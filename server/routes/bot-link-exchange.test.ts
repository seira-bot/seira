import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { BotLink } from "../bot-link/link.ts";
import { SYNC_PATH, TAKEN_HEADER } from "../bot-link/protocol.ts";
import { json, readBody } from "../harness/http.ts";
import { createLinkExchange } from "./bot-link-exchange.ts";
import type { RouteContext } from "./table.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

const CAUSE = "EACCES: permission denied, open '/data/links/abc/bot-link.json.tmp'";
const SYNC_ANSWER = { error: "the frames could not be taken now; try again later" };
const FILE_ANSWER = { error: "the file could not be handled now; try again later" };
const SYNC_BODY = { fresh: false, ack: 0, frames: [{ t: "cancel", id: "c1" }], wait: 0 };

type Part = Record<string, unknown>;
const linkOf = (part: Part): BotLink => ({
  setOnline: () => {}, setLevel: () => {}, sessionStarted: () => {}, has: () => true, hasOutgoing: () => false, outgoing: () => [], onOutgoing: () => () => {}, receive: () => {},
  holds: () => false, outgoingFile: () => undefined, incoming: () => undefined, ...part,
}) as unknown as BotLink;

/** The server around an exchange answers an error that escapes it the way the app's general handler does: with its message. */
async function listen(link: BotLink, options: Partial<Parameters<typeof createLinkExchange>[0]> = {}) {
  const logs: string[] = [];
  const exchange = createLinkExchange({ link, paths: { sync: SYNC_PATH, file: "/file" }, power: () => null, log: (line) => { logs.push(line); }, ...options });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ctx = { req, res, url, path: url.pathname, method: req.method ?? "GET", json, readBody } as unknown as RouteContext;
    exchange.serve(ctx, "peer", () => true).catch((error: unknown) => { if (!res.headersSent) json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) }); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { logs, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const postSync = (base: string, body: unknown = SYNC_BODY) => fetch(`${base}${SYNC_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("a link's exchange", () => {
  it("answers 503 with a fixed text when the frames could not be taken, gives back what it took, and logs the cause only here", async () => {
    const link = linkOf({ receive: () => { throw new Error(CAUSE); } });
    let undone = 0;
    const { base, logs } = await listen(link, { takes: (frames) => ({ count: frames.length, frames, undo: () => { undone += 1; } }) });

    const response = await postSync(base);
    const text = await response.text();
    expect([response.status, response.headers.get(TAKEN_HEADER), JSON.parse(text)]).toEqual([503, null, SYNC_ANSWER]);
    expect(text).not.toContain("/data/");
    expect(undone).toBe(1);
    expect(logs).toEqual([expect.stringContaining(CAUSE)]);
  });

  it("answers 503 with a fixed text when the link cannot note that the peer was seen", async () => {
    const { base, logs } = await listen(linkOf({ setOnline: () => { throw new Error(CAUSE); } }));

    const response = await postSync(base);
    const text = await response.text();
    expect([response.status, JSON.parse(text)]).toEqual([503, SYNC_ANSWER]);
    expect(text).not.toContain("/data/");
    expect(logs).toEqual([expect.stringContaining(CAUSE)]);
  });

  it("answers 503 with a fixed text when the link cannot record a new session", async () => {
    const { base, logs } = await listen(linkOf({ sessionStarted: () => { throw new Error(CAUSE); } }));

    const response = await postSync(base, { ...SYNC_BODY, fresh: true });
    const text = await response.text();
    expect([response.status, JSON.parse(text)]).toEqual([503, SYNC_ANSWER]);
    expect(text).not.toContain("/data/");
    expect(logs).toEqual([expect.stringContaining(CAUSE)]);
  });

  it("still answers a body that is too large or not JSON with its own status", async () => {
    const { base } = await listen(linkOf({}));

    expect((await fetch(`${base}${SYNC_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
    expect((await postSync(base, { ...SYNC_BODY, frames: ["x".repeat(5 * 1024 * 1024)] })).status).toBe(413);
  });

  it("answers 503 with a fixed text when the file route cannot note the peer, look up or keep a file", async () => {
    const query = "id=h1&way=sent&index=0&name=a.txt";
    for (const [part, init, path] of [
      [{ setOnline: () => { throw new Error(CAUSE); } }, { method: "GET" }, `/file?${query}&probe=1`],
      [{ holds: () => { throw new Error(CAUSE); } }, { method: "GET" }, `/file?${query}&probe=1`],
      [{ outgoingFile: () => { throw new Error(CAUSE); } }, { method: "GET" }, `/file?${query}`],
      [{ incoming: () => { throw new Error(CAUSE); } }, { method: "PUT", body: "abc" }, `/file?${query}`],
    ] as Array<[Part, RequestInit, string]>) {
      const { base, logs } = await listen(linkOf(part));
      const response = await fetch(`${base}${path}`, init);
      const text = await response.text();
      expect([response.status, JSON.parse(text)]).toEqual([503, FILE_ANSWER]);
      expect(text).not.toContain("/data/");
      expect(logs).toEqual([expect.stringContaining(CAUSE)]);
    }
  });
});
