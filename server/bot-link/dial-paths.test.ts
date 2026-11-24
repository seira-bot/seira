import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFrameBudget } from "../host/linked-servers-admit.ts";
import { removeTempDir } from "../testing/cleanup.ts";

import { FILE_IDLE_MS, createDialer } from "./dial.ts";
import type { BotLink, FileTransfer } from "./link.ts";
import { FILE_PATH, SYNC_PATH, TAKEN_HEADER, type Numbered } from "./protocol.ts";

const ORIGIN = "https://other.example";

function fakeLink() {
  let transfer: FileTransfer | null = null;
  const link = {
    dial: () => ({ origin: ORIGIN, token: "token-token-token-1" }),
    cloudPeer: () => "peer",
    sessionStarted: () => {},
    outgoing: () => [],
    hasOutgoing: () => false,
    setTransfer: (next: FileTransfer | null) => { transfer = next; },
    onOutgoing: () => () => {},
    onWanted: () => () => {},
    setOnline: () => {},
    setLevel: () => {},
    receive: () => {},
    setSleeps: () => {},
    sleeps: () => false,
    ended: () => [],
  } as unknown as BotLink;
  return { link, transfer: () => transfer! };
}

const answer = () => new Response(JSON.stringify({ session: "s1", frames: [] }), { status: 200, headers: { "content-type": "application/json" } });
const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "dial-paths-")); dirs.push(dir); return dir; };
afterEach(async () => { vi.useRealTimers(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });

async function urlsOf(paths?: { sync: string; file: string }) {
  const { link, transfer } = fakeLink();
  const urls: string[] = [];
  let seenSync!: () => void;
  const first = new Promise<void>((resolve) => { seenSync = resolve; });
  const dialer = createDialer({ link, holdMs: 50, ...(paths ? { paths } : {}),
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("probe")) return new Response(JSON.stringify({ have: true }), { status: 200 });
      seenSync();
      return answer();
    }) as typeof fetch });
  dialer.start();
  await first;
  await dialer.stop();
  await transfer().holds("id", "result" as never, 0, { name: "a.txt", bytes: 1, mime: "text/plain", kind: "file", path: "/nowhere" } as never);
  dialer.close();
  return urls;
}

describe("dialer paths", () => {
  it("uses the standard paths by default", async () => {
    const urls = await urlsOf();
    expect(urls[0]).toBe(`${ORIGIN}${SYNC_PATH}`);
    expect(urls.at(-1)).toContain(`${ORIGIN}${FILE_PATH}?`);
  });

  it("uses the paths it is given", async () => {
    const urls = await urlsOf({ sync: "/api/other/sync", file: "/api/other/file" });
    expect(urls[0]).toBe(`${ORIGIN}/api/other/sync`);
    expect(urls.at(-1)).toContain(`${ORIGIN}/api/other/file?`);
    expect(urls.some((url) => url.includes(SYNC_PATH) || url.includes(FILE_PATH))).toBe(false);
  });
});

/** The error a file request gets when the other side answers `status` with its own words. */
async function refusal(status: number, options: { farText?: boolean } = {}) {
  const { link, transfer } = fakeLink();
  const dialer = createDialer({ link, holdMs: 50, ...options,
    fetch: (async () => new Response(JSON.stringify({ error: "far side secret words" }), { status, headers: { "content-type": "application/json" } })) as typeof fetch });
  try {
    await transfer().holds("id", "result" as never, 0, { name: "a.txt", bytes: 1, mime: "text/plain", kind: "file", path: "/nowhere" } as never);
    throw new Error("the file request did not fail");
  } catch (error) {
    return { message: (error as Error).message, gone: (error as { gone?: boolean }).gone };
  } finally { dialer.close(); }
}

describe("a refused file", () => {
  it("carries the other side's words by default", async () => {
    expect(await refusal(404)).toEqual({ message: "far side secret words", gone: true });
  });

  it("carries only a fixed text when the other side's words must not reach this server", async () => {
    expect(await refusal(404, { farText: false })).toEqual({ message: "the other side did not take or give the file", gone: true });
    const denied = await refusal(403, { farText: false });
    expect(denied).toEqual({ message: "the other side did not take or give the file", gone: false });
    expect(denied.message).not.toContain("far side");
  });
});

/** A link whose frames for the other side wait in `outbox` until they are acknowledged. */
function outboxLink(outbox: Numbered[]) {
  const { link, transfer } = fakeLink();
  Object.assign(link, {
    outgoing: (_peer: string, upTo: number) => { while (outbox[0] && outbox[0].seq <= upTo) outbox.shift(); return [...outbox]; },
    hasOutgoing: () => outbox.length > 0,
  });
  return { link, transfer };
}
const FILE = { name: "a.txt", mime: "text/plain", kind: "file" as const, bytes: 1 };

describe("a dialer that keeps to the other side's limits", () => {
  it("sends no more work frames than the other side's budget has left, and a smaller batch after a refusal", async () => {
    const outbox: Numbered[] = Array.from({ length: 6 }, (_, index) => ({ seq: index + 1, frame: { t: "cancel" as const, id: `c${index + 1}` } }));
    const { link } = outboxLink(outbox);
    let left = 4, finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const batches: string[][] = [];
    const replies = [() => new Response(null, { status: 429 }), () => new Response(JSON.stringify({ session: "s1", frames: [] }), { status: 200, headers: { [TAKEN_HEADER]: "1" } })];
    const took = (count: number) => new Response(JSON.stringify({ session: "s1", frames: [] }), { status: 200, headers: { [TAKEN_HEADER]: String(count) } });
    const dialer = createDialer({ link, holdMs: 50, firstRetryMs: 5, budget: { left: () => left, spend: (frames) => { left -= frames; } },
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const sent = (JSON.parse(String(init?.body)) as { frames: Array<{ id: string }> }).frames.map((frame) => frame.id);
        batches.push(sent);
        if (!sent.length) { await new Promise((resolve) => setTimeout(resolve, 10)); finish(); }
        return replies.shift()?.() ?? took(sent.length);
      }) as typeof fetch });
    dialer.start();
    await finished;
    await dialer.stop();
    dialer.close();
    expect(batches.slice(0, 5)).toEqual([["c1", "c2", "c3", "c4"], ["c1", "c2"], ["c2", "c3"], ["c4"], []]);
    expect([left, outbox.map((entry) => (entry.frame as { id: string }).id)]).toEqual([0, ["c5", "c6"]]);
  });

  it("asks for no file while there is no room for it here, and tries it again later", async () => {
    const { link, transfer } = fakeLink();
    const asked: string[] = [];
    const dialer = createDialer({ link, holdMs: 50, room: () => null, fetch: (async (input: Parameters<typeof fetch>[0]) => { asked.push(String(input)); return answer(); }) as typeof fetch });
    const failure = await transfer().pull("id", "sent", 0, FILE, "/nowhere/a.txt").then(() => null, (error: unknown) => error as { gone?: boolean });
    dialer.close();
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.gone).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("gives the room back when a file request ends", async () => {
    const { link, transfer } = fakeLink();
    let released = 0;
    const dialer = createDialer({ link, holdMs: 50, farText: false, room: () => () => { released += 1; }, fetch: (async () => new Response(null, { status: 404 })) as typeof fetch });
    await expect(transfer().pull("id", "sent", 0, FILE, join(tempDir(), "spool", "a.txt"))).rejects.toMatchObject({ gone: true });
    dialer.close();
    expect(released).toBe(1);
  });

  it("reads no answer larger than its bound", async () => {
    const holds = async (answerMax?: number) => {
      const { link, transfer } = fakeLink();
      const dialer = createDialer({ link, holdMs: 50, ...(answerMax ? { answerMax } : {}),
        fetch: (async () => new Response(JSON.stringify({ have: true, more: "x".repeat(5_000) }), { status: 200 })) as typeof fetch });
      try { return await transfer().holds("id", "result" as never, 0, { ...FILE, path: "/nowhere" } as never); } catch { return "refused"; } finally { dialer.close(); }
    };
    expect(await holds()).toBe(true);
    expect(await holds(8 * 1024 * 1024)).toBe("refused");

    const { link } = fakeLink();
    const received: unknown[] = [], logs: string[] = [];
    let logged!: () => void;
    const failed = new Promise<void>((resolve) => { logged = resolve; });
    Object.assign(link, { receive: (_peer: string, frames: unknown[]) => { received.push(...frames); } });
    const dialer = createDialer({ link, holdMs: 50, answerMax: 100, log: (line) => { logs.push(line); logged(); },
      fetch: (async () => new Response(JSON.stringify({ session: "s1", frames: [{ seq: 1, frame: { t: "done", id: "x".repeat(150) } }] }), { status: 200 })) as typeof fetch });
    dialer.start();
    await failed;
    await dialer.stop();
    dialer.close();
    expect(received).toEqual([]);
    expect(logs[0]).toContain("too large");
  });
  it("makes the folder of a file only once there is room for it", async () => {
    const to = join(tempDir(), "spool", "h1", "sent", "0-a.txt");
    for (const room of [() => null, () => () => {}]) {
      const { link, transfer } = fakeLink();
      const dialer = createDialer({ link, holdMs: 50, farText: false, room, fetch: (async () => new Response("x", { status: 200 })) as typeof fetch });
      const failed = await transfer().pull("id", "sent", 0, FILE, to).then(() => false, () => true);
      dialer.close();
      expect([failed, existsSync(dirname(to)), existsSync(to)]).toEqual(room() ? [false, true, true] : [true, false, false]);
    }
  });

  it("gives up a file whose bytes stop coming, and keeps none of it", async () => {
    const { link, transfer } = fakeLink();
    const to = join(tempDir(), "spool", "a.txt");
    const stalled = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([120])); } });
    const dialer = createDialer({ link, holdMs: 50, farText: false, fileIdleMs: 50, room: () => () => {}, fetch: (async () => new Response(stalled(), { status: 200 })) as typeof fetch });
    const started = Date.now();
    const failure = await transfer().pull("id", "sent", 0, { ...FILE, bytes: 5 }, to).then(() => null, (error: unknown) => error as { gone?: boolean });
    dialer.close();
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.gone).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(existsSync(to)).toBe(false);
  }, 15_000);

  it("keeps a file whose bytes stop for longer than a guest link allows, when it is given no limit for that", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { link, transfer } = fakeLink();
    const to = join(tempDir(), "spool", "a.txt");
    const paused = () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([120]));
      setTimeout(() => { controller.enqueue(new Uint8Array([120, 120, 120, 120])); controller.close(); }, FILE_IDLE_MS + 1_000);
    } });
    const dialer = createDialer({ link, holdMs: 50, farText: false, room: () => () => {}, fetch: (async () => new Response(paused(), { status: 200 })) as typeof fetch });
    const pulled = transfer().pull("id", "sent", 0, { ...FILE, bytes: 5 }, to).then(() => "kept", (error: unknown) => String(error));
    await vi.advanceTimersByTimeAsync(FILE_IDLE_MS + 1_000);
    const outcome = await pulled;
    dialer.close();
    expect(outcome).toBe("kept");
    expect(readFileSync(to, "utf8")).toBe("xxxxx");
  });

  it("gives back what it took of an answer whose frames could not be taken", async () => {
    const { link } = fakeLink();
    let undone = 0, calls = 0, finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    Object.assign(link, { receive: () => { throw new Error("the disk is full"); } });
    const dialer = createDialer({ link, holdMs: 50, firstRetryMs: 5, takes: (frames) => ({ count: frames.length, frames, undo: () => { undone += 1; } }),
      fetch: (async () => {
        if (++calls === 2) finish();
        return new Response(JSON.stringify({ session: "s1", frames: [{ seq: 1, frame: { t: "cancel", id: "c1" } }] }), { status: 200 });
      }) as typeof fetch });
    dialer.start();
    await finished;
    await dialer.stop();
    dialer.close();
    expect(undone).toBeGreaterThanOrEqual(1);
  });

  it("waits for room when an answer is larger than what its bytes for the window have left, takes none of it, and gets it again later", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { link } = fakeLink();
    const received: string[] = [], online: boolean[] = [], asked: number[] = [];
    Object.assign(link, { receive: (_peer: string, frames: Array<{ id: string }>) => { received.push(...frames.map((frame) => frame.id)); },
      setOnline: (_peer: string, value: boolean) => { online.push(value); } });
    const waiting = Array.from({ length: 4 }, (_, index) => ({ seq: index + 1, frame: { t: "result", id: `r${index + 1}`, ok: true, text: "x".repeat(1_200) } }));
    const bytes = createFrameBudget(Date.now, 3_000);
    const dialer = createDialer({ link, farText: false, answerMax: 2_000, pace: { gapMs: 1_000, freshMs: 10_000 },
      reads: { left: () => bytes.left("peer"), spend: (count) => { bytes.spend("peer", count); }, waitFor: (count) => bytes.waitFor("peer", count) },
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const { ack } = JSON.parse(String(init?.body)) as { ack: number };
        asked.push(Date.now());
        while (waiting[0] && waiting[0].seq <= ack) waiting.shift();
        return new Response(JSON.stringify({ session: "s1", frames: waiting.slice(0, 1) }), { status: 200, headers: { [TAKEN_HEADER]: "0" } });
      }) as typeof fetch });
    dialer.start();
    await vi.advanceTimersByTimeAsync(59_000);
    const early = { received: [...received], asked: asked.length };
    await vi.advanceTimersByTimeAsync(70_000);
    await dialer.stop();
    dialer.close();
    expect(early).toEqual({ received: ["r1", "r2"], asked: 3 });
    expect(received).toEqual(["r1", "r2", "r3", "r4"]);
    expect([online.includes(false), dialer.state().needsPairing]).toEqual([false, false]);
  }, 15_000);

  it("shows the link as not online while a guest link's other side answers 429", async () => {
    const { link } = outboxLink([{ seq: 1, frame: { t: "cancel" as const, id: "c1" } }]);
    const online: boolean[] = [];
    let calls = 0, finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    Object.assign(link, { setOnline: (_peer: string, value: boolean) => { online.push(value); } });
    const dialer = createDialer({ link, holdMs: 50, firstRetryMs: 5, budget: { left: () => 150, spend: () => {} },
      fetch: (async () => {
        if (++calls === 3) finish();
        return calls === 1 ? new Response(JSON.stringify({ session: "s1", frames: [] }), { status: 200, headers: { [TAKEN_HEADER]: "0" } }) : new Response(null, { status: 429 });
      }) as typeof fetch });
    dialer.start();
    await finished;
    await dialer.stop();
    dialer.close();
    expect(online.slice(0, 2)).toEqual([true, false]);
  });
});

/** A guest dialer as a link wires it, over a fake clock, against `reply`; what it asked and how often a session began. */
async function paced(reply: (call: number) => Response, ms: number) {
  vi.useFakeTimers();
  const outbox: Numbered[] = [{ seq: 1, frame: { t: "cancel" as const, id: "c1" } }];
  const { link } = outboxLink(outbox);
  let calls = 0, sessions = 0;
  Object.assign(link, { sessionStarted: () => { sessions += 1; } });
  const dialer = createDialer({ link, holdMs: 25_000, firstRetryMs: 1_000, pace: { gapMs: 1_000, freshMs: 10_000 }, budget: { left: () => 150, spend: () => {} },
    fetch: (async () => reply(++calls)) as typeof fetch });
  dialer.start();
  await vi.advanceTimersByTimeAsync(ms);
  await dialer.stop();
  dialer.close();
  return { calls, sessions };
}

describe("a guest dialer's pace", () => {
  it("asks at most once a second and begins a new session at most every ten seconds, while the other side changes its session at each answer", async () => {
    const { calls, sessions } = await paced((call) => new Response(JSON.stringify({ session: `s${call}`, frames: [] }), { status: 200, headers: { [TAKEN_HEADER]: "0" } }), 60_000);
    expect(calls).toBeGreaterThan(5);
    expect(calls).toBeLessThanOrEqual(61);
    expect(sessions).toBeLessThanOrEqual(7);
  });

  it("asks less and less often while the other side answers 429", async () => {
    const { calls, sessions } = await paced(() => new Response(null, { status: 429 }), 60_000);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(8);
    expect(sessions).toBe(calls);
  });

  it("asks at most once a second while the other side answers a held request at once", async () => {
    const { calls, sessions } = await paced(() => new Response(JSON.stringify({ session: "s1", frames: [] }), { status: 200, headers: { [TAKEN_HEADER]: "1" } }), 60_000);
    expect(calls).toBeGreaterThanOrEqual(55);
    expect(calls).toBeLessThanOrEqual(61);
    expect(sessions).toBe(1);
  });
});

describe("the frames a dialer counts as taken", () => {
  it("counts none taken when a guest link's answer does not say how many, and all of them on the person's own link", async () => {
    for (const header of [undefined, "lots", "-1"]) {
      for (const guest of [true, false]) {
        const outbox: Numbered[] = [{ seq: 1, frame: { t: "cancel" as const, id: "c1" } }, { seq: 2, frame: { t: "cancel" as const, id: "c2" } }];
        const { link } = outboxLink(outbox);
        let calls = 0, spent = 0, finish!: () => void;
        const finished = new Promise<void>((resolve) => { finish = resolve; });
        const dialer = createDialer({ link, holdMs: 50, firstRetryMs: 5, ...(guest ? { budget: { left: () => 150, spend: (frames: number) => { spent += frames; } } } : {}),
          fetch: (async () => {
            if (++calls === 3) finish();
            return new Response(JSON.stringify({ session: "s1", frames: [] }), { status: 200, headers: header === undefined ? {} : { [TAKEN_HEADER]: header } });
          }) as typeof fetch });
        dialer.start();
        await finished;
        await dialer.stop();
        dialer.close();
        expect([header, guest, outbox.length, spent]).toEqual([header, guest, guest ? 2 : 0, 0]);
      }
    }
  });
});
