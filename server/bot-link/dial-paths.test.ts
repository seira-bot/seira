import { describe, expect, it } from "vitest";

import { createDialer } from "./dial.ts";
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
    const dialer = createDialer({ link, holdMs: 50, firstRetryMs: 5, budget: { left: () => left, spend: (frames) => { left -= frames; } },
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const sent = (JSON.parse(String(init?.body)) as { frames: Array<{ id: string }> }).frames.map((frame) => frame.id);
        batches.push(sent);
        if (!sent.length) { await new Promise((resolve) => setTimeout(resolve, 10)); finish(); }
        return (replies.shift() ?? answer)();
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
    await expect(transfer().pull("id", "sent", 0, FILE, "/nowhere/a.txt")).rejects.toMatchObject({ gone: true });
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
});
