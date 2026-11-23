import { describe, expect, it } from "vitest";

import { createDialer } from "./dial.ts";
import type { BotLink, FileTransfer } from "./link.ts";
import { FILE_PATH, SYNC_PATH } from "./protocol.ts";

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
