import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDialer, type SendPace } from "../bot-link/dial.ts";
import type { BotLink } from "../bot-link/link.ts";
import { EXCHANGE_BYTES, FILES_MAX, GUEST_EXCHANGE_MAX, HOLD_MS, SYNC_PATH, type Numbered } from "../bot-link/protocol.ts";
import { json, readBody } from "../harness/http.ts";
import { createLinkExchange } from "../routes/bot-link-exchange.ts";
import type { RouteContext } from "../routes/table.ts";
import { FILE_MAX_BYTES } from "../../shared/upload-limits.ts";
import { ADMIT, createFrameBudget, createIntake, createPace, createSendPace } from "./linked-servers-admit.ts";
import { farFrame, readFar } from "./linked-servers-text.ts";

afterEach(() => { vi.useRealTimers(); });

const PEER = "peer", LINK = "link-1", PATHS = { sync: SYNC_PATH, file: "/file" };
type Arrived = { at: number; frame: { t: string; id?: string } };

/** One side's link: its frames for the other side wait in order until they are acknowledged, and go in batches as a
 * link's do; what arrives is kept as the manager hands it on. */
function side() {
  const outbox: Numbered[] = [], arrived: Arrived[] = [];
  const listeners = new Set<(peer: string) => void>();
  let seq = 0;
  const link = {
    dial: () => ({ origin: "https://inviter.example", token: "token-token-token-1" }),
    cloudPeer: () => PEER, has: () => true, sessionStarted: () => {}, setOnline: () => {}, setLevel: () => {}, setTransfer: () => {}, setSleeps: () => {},
    sleeps: () => false, ended: () => [], onWanted: () => () => {},
    onOutgoing: (listener: (peer: string) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    outgoing: (_peer: string, ack: number) => {
      while (outbox[0] && outbox[0].seq <= ack) outbox.shift();
      const batch: Numbered[] = [];
      let bytes = 0;
      for (const entry of outbox) {
        bytes += JSON.stringify(entry.frame).length;
        if (batch.length > 0 && (bytes > EXCHANGE_BYTES || batch.length >= 500)) break;
        batch.push(entry);
      }
      return batch;
    },
    hasOutgoing: (_peer: string, ack = 0) => outbox.some((entry) => entry.seq > ack),
    receive: (_peer: string, frames: readonly unknown[]) => { for (const frame of frames) arrived.push({ at: Date.now(), frame: farFrame(frame) as Arrived["frame"] }); },
  } as unknown as BotLink;
  const queue = (frame: unknown) => {
    outbox.push({ seq: ++seq, frame } as Numbered);
    for (const listener of listeners) listener(PEER);
  };
  return { link, arrived, queue };
}

/** One server's limits for the link, as the manager makes them. */
function limits() {
  const intake = createIntake(Date.now, {}, readFar), work = createFrameBudget(Date.now), bytes = createFrameBudget(Date.now, ADMIT.bytes);
  const pace = createPace(Date.now), sending = createSendPace(Date.now);
  const sends: SendPace = { next: (frames) => sending.next(LINK, frames), sent: (frames) => sending.sent(LINK, frames), took: (all, taken) => sending.took(LINK, all, taken) };
  return { intake, work, bytes, pace, sends };
}

/** A response as the exchange writes it. */
class Reply extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  setHeader(name: string, value: string | number) { this.headers[name.toLowerCase()] = String(value); return this; }
  removeHeader(name: string) { delete this.headers[name.toLowerCase()]; }
  getHeader(name: string) { return this.headers[name.toLowerCase()]; }
  hasHeader(name: string) { return name.toLowerCase() in this.headers; }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }
  end(data = "") { this.body += data; this.writableEnded = true; this.emit("finish"); this.emit("close"); return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
}

/** An inviter and a joiner linked as the manager links them, the joiner's requests served in this process. */
function linkedPair() {
  const inviter = side(), joiner = side(), atInviter = limits(), atJoiner = limits();
  const statuses: number[] = [];
  const exchange = createLinkExchange({ link: inviter.link, paths: PATHS, power: () => null, log: () => {},
    takes: (frames) => atInviter.intake.take(LINK, frames, false),
    pace: { exchange: () => atInviter.pace.exchange(LINK), session: () => atInviter.pace.session(LINK) },
    bytes: { max: GUEST_EXCHANGE_MAX, spend: (bytes) => { if (atInviter.bytes.left(LINK) < bytes) return false; atInviter.bytes.spend(LINK, bytes); return true; },
      left: () => atInviter.bytes.left(LINK), giveBack: (bytes) => atInviter.bytes.giveBack(LINK, bytes) },
    sends: atInviter.sends });
  const served = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = Buffer.from(String(init?.body ?? ""));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    const req = Object.assign(Readable.from([body]), { headers: { ...headers, "content-length": String(body.length) }, method: "POST", url: SYNC_PATH });
    const res = new Reply(), url = new URL(String(input));
    const ctx = { req, res, url, path: url.pathname, method: "POST", json, readBody } as unknown as RouteContext;
    return new Promise<Response>((resolve, reject) => {
      const abort = () => { res.destroy(); reject(new DOMException("The request was aborted", "AbortError")); };
      if (init?.signal?.aborted) { abort(); return; }
      init?.signal?.addEventListener("abort", abort, { once: true });
      exchange.serve(ctx, PEER, () => true).catch((error: unknown) => { json(res as never, (error as { status?: number }).status ?? 500, { error: String(error) }); }).then(() => {
        init?.signal?.removeEventListener("abort", abort);
        if (res.destroyed) return;
        statuses.push(res.statusCode);
        resolve(new Response(res.body, { status: res.statusCode, headers: res.headers }));
      }, reject);
    });
  }) as typeof fetch;
  const dialer = createDialer({ link: joiner.link, fetch: served, paths: PATHS, farText: false, log: () => {}, answerMax: GUEST_EXCHANGE_MAX, pace: { gapMs: 1_000, freshMs: 10_000 },
    takes: (frames) => atJoiner.intake.take(LINK, frames, false),
    budget: { left: () => atJoiner.work.left(LINK), spend: (frames) => { atJoiner.work.spend(LINK, frames); } },
    reads: { left: () => atJoiner.bytes.left(LINK), spend: (bytes) => { atJoiner.bytes.spend(LINK, bytes); }, waitFor: (bytes) => atJoiner.bytes.waitFor(LINK, bytes) },
    sends: atJoiner.sends });
  return {
    inviter, joiner, statuses,
    start: () => { dialer.start(); },
    async stop() { await dialer.stop(); dialer.close(); await vi.advanceTimersByTimeAsync(10); },
  };
}

/** Moves the fake clock on by `ms`, a little at a time, so each exchange runs at about its own time. */
async function run(ms: number): Promise<void> {
  for (let passed = 0; passed < ms; passed += 250) await vi.advanceTimersByTimeAsync(250);
}
const fakeClock = () => vi.useFakeTimers({ now: 0, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

const wide = (length: number) => "\u0001".repeat(length);
const fileOf = (name: string) => ({ name, mime: wide(200), kind: "image", bytes: FILE_MAX_BYTES });
/** The largest frame of each kind that a guest link takes: each character escaped to six bytes, its ids of the characters
 * an id may hold. */
const LARGEST = {
  hello: { t: "hello", place: { id: wide(200), name: wide(120) }, bots: Array.from({ length: 500 }, (_, index) => ({ id: `b${index}`.padEnd(128, "b"), name: wide(120),
    title: wide(200), description: wide(400), model: wide(200), level: "custom", color: wide(64), mascotBody: wide(64), mascotFaceColor: wide(64),
    mascotAccessories: Array.from({ length: 12 }, () => wide(40)), chief: true, threadId: `t${index}`.padEnd(128, "t") })) },
  handoff: { t: "handoff", id: "h".repeat(200), to: "w".repeat(200), from: { botId: "s".repeat(200), name: wide(120), threadId: "u".repeat(200) }, thread: "v".repeat(200),
    text: wide(12_000), mode: "consult", origin: { kind: "outside", quote: wide(2_000) }, person: wide(120), doneWhen: wide(2_000),
    files: Array.from({ length: FILES_MAX }, () => fileOf(wide(255))) },
  result: { t: "result", id: "h".repeat(200), ok: true, text: wide(200_000), outcome: wide(40), files: Array.from({ length: FILES_MAX }, () => fileOf(wide(255))) },
  done: { t: "done", id: "d".repeat(200) },
  cancel: { t: "cancel", id: "c".repeat(200) },
  bye: { t: "bye" },
};
/** The same frames with each id that may hold any character made of characters escaped to six bytes. */
const WORST = [LARGEST.hello, { ...LARGEST.handoff, id: wide(200), to: wide(200), thread: wide(200), from: { botId: wide(200), name: wide(120), threadId: wide(200) } },
  { ...LARGEST.result, id: wide(200) }, { t: "done", id: wide(200) }, { t: "cancel", id: wide(200) }, LARGEST.bye];

describe("the limits of a guest link", () => {
  const request = (frames: unknown[]) => Buffer.byteLength(JSON.stringify({ fresh: false, ack: Number.MAX_SAFE_INTEGER, frames, wait: HOLD_MS }));
  const answer = (frames: unknown[]) => Buffer.byteLength(JSON.stringify({ session: "s".repeat(80), frames: frames.map((frame) => ({ seq: Number.MAX_SAFE_INTEGER, frame })) }));

  it("read the largest frame of each kind, and the largest batch a link sends, in one request or answer", () => {
    for (const frame of [...Object.values(LARGEST), ...WORST]) {
      expect(readFar(frame).frame).not.toBeNull();
      expect(Math.max(request([frame]), answer([frame]))).toBeLessThanOrEqual(GUEST_EXCHANGE_MAX);
    }
    const perFrame = answer([null]) - answer([]);
    expect(3 * EXCHANGE_BYTES + 500 * perFrame + answer([])).toBeLessThanOrEqual(GUEST_EXCHANGE_MAX);
  });

  it("let a side read a largest request or answer in an empty window, and an honest side send less in a window than the other side reads", () => {
    expect(GUEST_EXCHANGE_MAX).toBeLessThanOrEqual(ADMIT.bytes);
    expect(ADMIT.sendBytes + ADMIT.exchanges * Math.max(request([]), answer([]))).toBeLessThan(ADMIT.bytes);
    expect(Buffer.byteLength(JSON.stringify(LARGEST.result))).toBeLessThan(ADMIT.sendBytes);
  });
});

describe("an honest pair at a guest link's limits", () => {
  for (const from of ["joiner", "inviter"] as const) {
    it(`carries a backlog of results from the ${from} in order and once each within six windows, with no 429, while a frame the other way crosses at once`, async () => {
      fakeClock();
      const pair = linkedPair();
      const [sender, receiver] = from === "joiner" ? [pair.joiner, pair.inviter] : [pair.inviter, pair.joiner];
      const ids = Array.from({ length: 6 }, (_, index) => `r${index + 1}`);
      for (const id of ids) sender.queue({ t: "result", id, ok: true, text: "x".repeat(200_000) });
      pair.start();
      await run(30_000);
      receiver.queue({ t: "result", id: "back", ok: true, text: "ok" });
      await run(6 * ADMIT.windowMs - 30_000);
      await pair.stop();
      expect(receiver.arrived.map((one) => one.frame.id)).toEqual(ids);
      expect(sender.arrived.map((one) => [one.frame.id, one.at - 30_000 <= 5_000])).toEqual([["back", true]]);
      expect(pair.statuses.length).toBeGreaterThan(0);
      expect(pair.statuses.filter((status) => status !== 200)).toEqual([]);
    }, 120_000);

    it(`carries the largest frame of each kind from the ${from}, in order and once each, within four windows, with no 429`, async () => {
      fakeClock();
      const pair = linkedPair();
      const [sender, receiver] = from === "joiner" ? [pair.joiner, pair.inviter] : [pair.inviter, pair.joiner];
      for (const frame of Object.values(LARGEST)) sender.queue(frame);
      pair.start();
      await run(4 * ADMIT.windowMs);
      await pair.stop();
      expect(receiver.arrived.map((one) => one.frame.t)).toEqual(Object.keys(LARGEST));
      expect(pair.statuses.filter((status) => status !== 200)).toEqual([]);
    }, 120_000);
  }
});
