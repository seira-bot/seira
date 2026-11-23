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

describe("a link's exchange", () => {
  it("answers 503 with a fixed text when the frames could not be taken, gives back what it took, and logs the cause only here", async () => {
    const cause = "ENOSPC: no space left on device, open '/data/links/abc/bot-link.json.tmp'";
    const link = {
      setOnline: () => {}, setLevel: () => {}, sessionStarted: () => {}, has: () => true, hasOutgoing: () => false, outgoing: () => [], onOutgoing: () => () => {},
      receive: () => { throw new Error(cause); },
    } as unknown as BotLink;
    const logs: string[] = [];
    let undone = 0;
    const exchange = createLinkExchange({ link, paths: { sync: SYNC_PATH, file: "/file" }, power: () => null, log: (line) => { logs.push(line); },
      takes: (frames) => ({ count: frames.length, frames, undo: () => { undone += 1; } }) });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const ctx = { req, res, url, path: url.pathname, method: req.method ?? "GET", json, readBody } as unknown as RouteContext;
      exchange.serve(ctx, "peer", () => true).catch((error: unknown) => { if (!res.headersSent) json(res, 500, { error: String(error) }); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${SYNC_PATH}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fresh: false, ack: 0, frames: [{ t: "cancel", id: "c1" }], wait: 0 }) });
    const text = await response.text();
    expect([response.status, response.headers.get(TAKEN_HEADER), JSON.parse(text)]).toEqual([503, null, { error: "the frames could not be taken now; try again later" }]);
    expect(text).not.toContain("/data/");
    expect(undone).toBe(1);
    expect(logs).toEqual([expect.stringContaining(cause)]);
  });
});
