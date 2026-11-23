import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { BotLink } from "../bot-link/link.ts";
import { SYNC_PATH, TAKEN_HEADER } from "../bot-link/protocol.ts";
import { json, readBody } from "../harness/http.ts";
import { ADMIT, createFrameBudget } from "../host/linked-servers-admit.ts";
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
async function listen(link: BotLink, options: Partial<Parameters<typeof createLinkExchange>[0]> = {}, read: typeof readBody = readBody) {
  const logs: string[] = [];
  const exchange = createLinkExchange({ link, paths: { sync: SYNC_PATH, file: "/file" }, power: () => null, log: (line) => { logs.push(line); }, ...options });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ctx = { req, res, url, path: url.pathname, method: req.method ?? "GET", json, readBody: read } as unknown as RouteContext;
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

describe("a guest link's exchange bytes", () => {
  /** An exchange whose peer may send `limit` bytes a window: what it read, what it took, and what each request was charged. */
  async function limited(limit: number, max: number, now: () => number) {
    const budget = createFrameBudget(now, limit), charged: number[] = [];
    let reads = 0, received = 0;
    const counted: typeof readBody = (req, cap) => { reads += 1; return readBody(req, cap); };
    const { base } = await listen(linkOf({ receive: () => { received += 1; } }), {
      bytes: { max, spend: (bytes) => { charged.push(bytes); if (budget.left("peer") < bytes) return false; budget.spend("peer", bytes); return true; } } }, counted);
    return { base, charged, counts: () => [reads, received] };
  }
  const sized = (bytes: number) => {
    const body = { ...SYNC_BODY, frames: [{ t: "cancel", id: "" }] };
    body.frames[0]!.id = "c".repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
    return body;
  };
  const chunked = (base: string, body: unknown) => new Promise<number>((resolve, reject) => {
    const sent = request(`${base}${SYNC_PATH}`, { method: "POST", headers: { "content-type": "application/json" } }, (answer) => { answer.resume(); resolve(answer.statusCode ?? 0); });
    sent.on("error", reject);
    sent.write(JSON.stringify(body));
    sent.end();
  });

  it("answers 429 before it reads a request past the bytes left for the window, and reads it again in the next window", async () => {
    let now = 0;
    const { base, charged, counts } = await limited(3_000, 2_000, () => now);
    expect([(await postSync(base, sized(1_000))).status, (await postSync(base, sized(1_500))).status]).toEqual([200, 200]);
    const refused = await postSync(base, sized(600));
    expect([refused.status, await refused.json()]).toEqual([429, { error: "too many requests; try again later" }]);
    expect(counts()).toEqual([2, 2]);
    expect(charged).toEqual([1_000, 1_500, 600]);
    now = ADMIT.windowMs;
    expect((await postSync(base, sized(1_500))).status).toBe(200);
    expect(counts()).toEqual([3, 3]);
  });

  it("charges a request that does not say its size the most one request may carry, and one that says more than that the same", async () => {
    let now = 0;
    const { base, charged, counts } = await limited(3_000, 2_000, () => now);
    expect(await chunked(base, sized(100))).toBe(200);
    expect(await chunked(base, sized(100))).toBe(429);
    expect((await postSync(base, sized(2_500))).status).toBe(429);
    expect([charged, counts()]).toEqual([[2_000, 2_000, 2_000], [1, 1]]);
    now = ADMIT.windowMs;
    expect((await postSync(base, sized(2_500))).status).toBe(413);
    expect(counts()).toEqual([2, 1]);
  });

  it("answers only what its pace lets go, and learns from the next acknowledgment how much of the work the peer took", async () => {
    const waiting = [{ seq: 1, frame: { t: "cancel", id: "c1" } }, { seq: 2, frame: { t: "done", id: "d1" } }, { seq: 3, frame: { t: "cancel", id: "c2" } }];
    const told: Array<[number, number]> = [];
    const link = linkOf({ outgoing: (_peer: string, ack: number) => waiting.filter((entry) => entry.seq > ack), hasOutgoing: () => true });
    const { base } = await listen(link, { sends: { next: (frames) => ({ count: Math.min(2, frames.length), waitMs: 0 }), sent: () => {}, took: (work, taken) => { told.push([work, taken]); } } });
    const ask = async (ack: number, fresh = false) => (await (await postSync(base, { fresh, ack, frames: [], wait: 0 })).json() as { frames: Array<{ seq: number }> }).frames.map((one) => one.seq);
    expect(await ask(0, true)).toEqual([1, 2]);
    expect(await ask(0)).toEqual([1, 2]);
    expect(await ask(2)).toEqual([3]);
    expect(told).toEqual([[1, 0], [1, 1]]);
  });
});
