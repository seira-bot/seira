import { describe, expect, it } from "vitest";

import type { Frame, HandoffFrame, Numbered, ResultFrame } from "../bot-link/protocol.ts";
import { createA2aTransport } from "./transport.ts";

const KEY = "abcd1234";
const handoff = (id: string): HandoffFrame => ({
  t: "handoff", id, to: "far-bot", from: { botId: "writer", name: "Writer", threadId: "t1" }, thread: "t1", text: `Do ${id}`, mode: "work", origin: { kind: "outside" },
});
const result = (id: string): ResultFrame => ({ t: "result", id, ok: true, text: `Done ${id}` });
const flush = () => new Promise<void>((resolve) => { queueMicrotask(resolve); });

function fixture() {
  const listeners = new Set<(peer: string) => void>();
  const link = {
    on: true, seq: 0, sessions: 0, online: [] as boolean[], outbox: [] as Numbered[],
    has: (peer: string): boolean => link.on && peer === KEY,
    onOutgoing: (listener: (peer: string) => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    outgoing: (peer: string, ack: number): Numbered[] => (peer === KEY ? link.outbox.filter((entry) => entry.seq > ack) : []),
    setOnline: (_peer: string, online: boolean): void => { link.online.push(online); },
    sessionStarted: (): void => { link.sessions += 1; },
    push(frame: Frame, peer = KEY): void { link.seq += 1; link.outbox.push({ seq: link.seq, frame }); for (const listener of listeners) listener(peer); },
    listeners,
  };
  const seen = { settled: [] as string[], sent: [] as string[], cancelled: [] as string[], closed: [] as string[], logs: [] as string[], failOn: "" };
  const transport = createA2aTransport({
    link, key: KEY, log: (line) => { seen.logs.push(line); },
    inbound: {
      settled: (id, frame) => { if (id === seen.failOn) throw new Error("broken"); seen.settled.push(`${id}:${frame.text}`); },
      close: () => { seen.closed.push("inbound"); },
    },
    outbound: {
      send: (frame) => { seen.sent.push(frame.id); },
      cancel: (id) => { seen.cancelled.push(id); },
      close: () => { seen.closed.push("outbound"); },
    },
  });
  return { link, seen, transport };
}

describe("the A2A transport", () => {
  it("puts the peer online, starts a session and routes what waits in the outbox, at once", () => {
    const { link, seen, transport } = fixture();
    link.push(result("r1"));
    link.push(handoff("h1"));
    transport.start();
    expect([link.online, link.sessions]).toEqual([[true], 1]);
    expect([seen.settled, seen.sent]).toEqual([["r1:Done r1"], ["h1"]]);
  });

  it("routes a result to the inbound side, a hand-off and a cancel to the outbound side, and drops other frames", async () => {
    const { link, seen, transport } = fixture();
    transport.start();
    link.push(result("r1"));
    link.push(handoff("h1"));
    link.push({ t: "cancel", id: "h1" });
    link.push({ t: "done", id: "r0" });
    link.push({ t: "hello", place: { id: "far", name: "Far" }, bots: [] });
    await flush();
    expect([seen.settled, seen.sent, seen.cancelled]).toEqual([["r1:Done r1"], ["h1"], ["h1"]]);
  });

  it("routes each frame once, and only frames after the last one it took", async () => {
    const { link, seen, transport } = fixture();
    transport.start();
    link.push(handoff("h1"));
    await flush();
    link.push(handoff("h2"));
    link.push(handoff("h3"));
    await flush();
    expect(seen.sent).toEqual(["h1", "h2", "h3"]);
  });

  it("does not wake for another peer of the link", async () => {
    const { link, seen, transport } = fixture();
    transport.start();
    link.push(handoff("h1"), "ffff0000");
    await flush();
    expect(seen.sent).toEqual([]);
    link.push(handoff("h2"));
    await flush();
    expect(seen.sent).toEqual(["h1", "h2"]);
  });

  it("logs a frame that fails and goes on with the next one", async () => {
    const { link, seen, transport } = fixture();
    transport.start();
    seen.failOn = "r1";
    link.push(result("r1"));
    link.push(result("r2"));
    await flush();
    expect(seen.settled).toEqual(["r2:Done r2"]);
    expect(seen.logs).toEqual(["a2a: a result frame for the peer failed (Error: broken)"]);
  });

  it("reads from the first frame again after the link was off, because the link numbers its frames from 1 again", async () => {
    const { link, seen, transport } = fixture();
    transport.start();
    link.push(handoff("h1"));
    link.push(handoff("h2"));
    await flush();
    link.on = false;
    link.outbox = [];
    link.seq = 0;
    link.push(handoff("lost"));
    await flush();
    link.outbox = [];
    link.seq = 0;
    link.on = true;
    link.push(handoff("h3"));
    await flush();
    expect(seen.sent).toEqual(["h1", "h2", "h3"]);
  });

  it("closes once: the peer goes offline, both sides close, later frames go nowhere and start does nothing", async () => {
    const { link, seen, transport } = fixture();
    transport.start();
    transport.close();
    transport.close();
    expect([link.online, seen.closed, link.listeners.size]).toEqual([[true, false], ["inbound", "outbound"], 0]);
    link.push(handoff("h1"));
    transport.start();
    await flush();
    expect([seen.sent, link.sessions, link.online]).toEqual([[], 1, [true, false]]);
  });

  it("starts again in place, with one subscription", async () => {
    const { link, seen, transport } = fixture();
    transport.start();
    link.push(handoff("h1"));
    await flush();
    transport.start();
    expect([link.listeners.size, link.sessions, seen.sent]).toEqual([1, 2, ["h1", "h1"]]);
  });
});
