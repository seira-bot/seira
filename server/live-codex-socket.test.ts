import { describe, expect, it, vi } from "vitest";
import type { EngineLiveVoiceSession } from "./contracts.ts";
import { LiveCodexSocket } from "./live-codex-socket.ts";

function fakeSession() {
  const stop = vi.fn(async () => {});
  const session: EngineLiveVoiceSession = { sdp: "answer", appendText: vi.fn(), appendSpeech: vi.fn(), stop };
  return { session, stop };
}

function wired(options: ConstructorParameters<typeof LiveCodexSocket>[0] = {}) {
  const socket = new LiveCodexSocket(options);
  const frames: Array<Record<string, any>> = [];
  const order: string[] = [];
  const closes: unknown[] = [];
  socket.onopen = () => order.push("open");
  socket.onmessage = (e) => { frames.push(JSON.parse(String(e.data))); order.push(String(frames.at(-1)!.type)); };
  socket.onclose = (e) => closes.push(e);
  return { socket, frames, order, closes };
}

describe("LiveCodexSocket", () => {
  it("is connecting until started, then open, and opens before its first frame", () => {
    const t = wired();
    expect(t.socket.readyState).toBe(0);
    t.socket.event({ type: "started" });
    expect(t.socket.readyState).toBe(1);
    expect(t.order).toEqual(["open", "session.started"]);
  });

  it("replays a start that came before the controller set its handlers", async () => {
    const socket = new LiveCodexSocket();
    socket.event({ type: "started" });
    socket.event({ type: "transcript", role: "user", delta: "hi" });
    const order: string[] = [];
    socket.onopen = () => order.push("open");
    socket.onmessage = (e) => order.push(JSON.parse(String(e.data)).type);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["open", "session.started", "session.input_transcript.delta"]);
  });

  it("maps transcripts to deltas with a monotonic time range per speaker", () => {
    let now = 1_000;
    const t = wired({ now: () => now });
    t.socket.event({ type: "started" });
    now = 1_400;
    t.socket.event({ type: "transcript", role: "user", delta: "he" });
    now = 1_900;
    t.socket.event({ type: "transcript", role: "user", delta: "llo" });
    now = 9_000;
    t.socket.event({ type: "transcript", role: "assistant", delta: "ok" });
    const [, a, b, c] = t.frames;
    expect(a).toMatchObject({ type: "session.input_transcript.delta", delta: "he", start_ms: 400, end_ms: 400 });
    expect(b).toMatchObject({ type: "session.input_transcript.delta", delta: "llo", start_ms: 400, end_ms: 900 });
    expect(c).toMatchObject({ type: "session.output_transcript.delta", delta: "ok", start_ms: 8_000, end_ms: 8_000 });
  });

  it("sends at most one activity frame a second for Codex work", () => {
    let now = 5_000;
    const t = wired({ now: () => now });
    t.socket.event({ type: "started" });
    for (let step = 0; step < 5; step++) {
      now += 200;
      t.socket.event({ type: "working" });
    }
    expect(t.frames.filter((frame) => frame.type === "session.activity")).toHaveLength(1);
    now += 1_000;
    t.socket.event({ type: "working" });
    expect(t.frames.filter((frame) => frame.type === "session.activity")).toHaveLength(2);
    expect(t.frames.at(-1)).toEqual({ type: "session.activity" });
  });

  it("sends no activity frame after the socket closed", () => {
    const t = wired();
    t.socket.event({ type: "started" });
    t.socket.close();
    t.socket.event({ type: "working" });
    expect(t.frames.some((frame) => frame.type === "session.activity")).toBe(false);
  });

  it("starts a new utterance after a pause", () => {
    let now = 0;
    const t = wired({ now: () => now });
    t.socket.event({ type: "started" });
    now = 500;
    t.socket.event({ type: "transcript", role: "user", delta: "a" });
    now = 5_000;
    t.socket.event({ type: "transcript", role: "user", delta: "b" });
    expect(t.frames[2]).toMatchObject({ start_ms: 5_000, end_ms: 5_000 });
  });

  it("sends no frame for an answer or an approval", () => {
    const t = wired();
    t.socket.event({ type: "started" });
    t.socket.event({ type: "answer", text: "done" } as never);
    t.socket.event({ type: "approval", question: "ok?" } as never);
    expect(t.frames).toHaveLength(1);
  });

  it("maps a close to a closed frame, closes once and stops the session once", async () => {
    const { session, stop } = fakeSession();
    const onClosed = vi.fn();
    const t = wired({ onClosed });
    t.socket.attach(session);
    t.socket.event({ type: "started" });
    t.socket.event({ type: "closed", reason: "expired" });
    t.socket.event({ type: "closed", reason: "content" });
    await t.socket.stop();
    expect(t.frames.at(-1)).toEqual({ type: "session.closed", reason: "expired" });
    expect(t.closes).toEqual([{ code: 1000 }]);
    expect(t.socket.readyState).toBe(3);
    expect(stop).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("reports an unknown close reason as a remote hang-up", () => {
    const t = wired();
    t.socket.event({ type: "started" });
    t.socket.event({ type: "closed", reason: "weird" });
    expect(t.frames.at(-1)).toEqual({ type: "session.closed", reason: "remote_hangup" });
  });

  it("maps a failure to an error frame, then closes with an error code", () => {
    const { session, stop } = fakeSession();
    const t = wired();
    t.socket.attach(session);
    t.socket.event({ type: "started" });
    t.socket.event({ type: "failed", reason: "exit" });
    expect(t.frames.at(-1)).toEqual({ type: "error", error: { code: "exit" } });
    expect(t.closes).toEqual([{ code: 1011 }]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("sends text appends to the session and speech to its speech input", () => {
    const { session } = fakeSession();
    const t = wired();
    t.socket.attach(session);
    t.socket.event({ type: "started" });
    t.socket.send(JSON.stringify({ type: "session.instructions.append", delegation_id: "d", content: "one" }));
    t.socket.send(JSON.stringify({ type: "session.thinking.append", delegation_id: "d", content: "two" }));
    t.socket.send(JSON.stringify({ type: "session.commentary.append", delegation_id: "d", content: "three" }));
    t.socket.send("not json");
    t.socket.send(JSON.stringify({ type: "other", content: "x" }));
    expect(session.appendText).toHaveBeenCalledWith("one");
    expect(session.appendText).toHaveBeenCalledWith("two");
    expect(session.appendSpeech).toHaveBeenCalledWith("three");
    expect(session.appendText).toHaveBeenCalledTimes(2);
    expect(session.appendSpeech).toHaveBeenCalledOnce();
  });

  it("stops the session and then closes when the controller sends session.close", async () => {
    const { session, stop } = fakeSession();
    const t = wired();
    t.socket.attach(session);
    t.socket.event({ type: "started" });
    t.socket.send(JSON.stringify({ type: "session.close" }));
    await vi.waitFor(() => expect(t.closes).toEqual([{ code: 1000 }]));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the session once when closed by the controller", () => {
    const { session, stop } = fakeSession();
    const t = wired();
    t.socket.attach(session);
    t.socket.close(1000);
    t.socket.close(1000);
    void t.socket.stop();
    expect(stop).toHaveBeenCalledOnce();
    expect(t.closes).toHaveLength(1);
  });

  it("stops a session that attaches after the socket closed", () => {
    const { session, stop } = fakeSession();
    const t = wired();
    t.socket.close();
    expect(stop).not.toHaveBeenCalled();
    t.socket.attach(session);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("ignores events and sends after it closed", () => {
    const { session } = fakeSession();
    const t = wired();
    t.socket.attach(session);
    t.socket.event({ type: "started" });
    t.socket.close();
    const count = t.frames.length;
    t.socket.event({ type: "transcript", role: "user", delta: "late" });
    t.socket.send(JSON.stringify({ type: "session.instructions.append", content: "late" }));
    expect(t.frames).toHaveLength(count);
    expect(session.appendText).not.toHaveBeenCalled();
  });

  it("survives a stop that rejects", async () => {
    const session: EngineLiveVoiceSession = { sdp: "a", appendText: vi.fn(), appendSpeech: vi.fn(), stop: vi.fn(async () => { throw new Error("boom"); }) };
    const t = wired();
    t.socket.attach(session);
    await expect(t.socket.stop()).resolves.toBeUndefined();
  });
});
