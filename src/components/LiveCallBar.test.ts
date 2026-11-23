import { describe, expect, it, vi } from "vitest";
import { hangUpRemoteCall, liveCallBarView, liveLineHeldElsewhere } from "./LiveCallBar";
import type { LiveMediaState } from "@/lib/live-call-media";

const bot = { id: "b1", threadId: "t1", name: "Ada" };
const idle: LiveMediaState = { phase: "idle", callId: null, botId: null, threadId: null, startedAt: null, muted: false, caption: "", heard: "", notice: null, needsKey: false, busyWith: null, action: null, hangingUp: false };

describe("liveCallBarView", () => {
  it("shows nothing without a call on this chat", () => {
    expect(liveCallBarView({ bot, media: idle, server: null })).toBeNull();
    expect(liveCallBarView({ bot, media: { ...idle, phase: "live", callId: "c", botId: "b2", threadId: "t2", startedAt: 0 }, server: null })).toBeNull();
  });
  it("shows nothing for this window's own running call: the call pill carries it", () => {
    const media: LiveMediaState = { ...idle, phase: "live", callId: "c", botId: "b1", threadId: "t1", startedAt: 1_000 };
    expect(liveCallBarView({ bot, media, server: null })).toBeNull();
    expect(liveCallBarView({ bot, media: { ...media, phase: "starting" }, server: null })).toBeNull();
    expect(liveCallBarView({ bot, media: { ...media, phase: "ending" }, server: null })).toBeNull();
  });
  it("shows a phone's call on this chat", () => {
    const server = { callId: "c9", botId: "b1", threadId: "t1", client: "ios", voice: "marin", startedAt: 0, status: "live" } as const;
    expect(liveCallBarView({ bot, media: idle, server })).toEqual({ kind: "remote", title: "Ada is on a Live call from an iPhone", callId: "c9" });
  });
  it("shows a web browser's call on this chat", () => {
    const server = { callId: "c9", botId: "b1", threadId: "t1", client: "web", voice: "marin", startedAt: 0, status: "live" } as const;
    expect(liveCallBarView({ bot, media: idle, server })).toEqual({ kind: "remote", title: "Ada is on a Live call from a web browser", callId: "c9" });
  });
  it("hides a phone's call while it ends, and shows one in a status it does not know, so it can be hung up", () => {
    const server = { callId: "c9", botId: "b1", threadId: "t1", client: "ios", voice: "marin", startedAt: 0, status: "live" } as const;
    expect(liveCallBarView({ bot, media: idle, server: { ...server, status: "ending" } })).toBeNull();
    expect(liveCallBarView({ bot, media: idle, server: { ...server, status: "ended" } })).toBeNull();
    const unknown = { ...server, status: "on-hold" } as unknown as typeof server;
    expect(liveCallBarView({ bot, media: idle, server: unknown })).toMatchObject({ kind: "remote", callId: "c9" });
  });
  it("shows why a call stopped, with the one action that helps", () => {
    expect(liveCallBarView({ bot, media: { ...idle, phase: "failed", botId: "b1", threadId: "t1", notice: "Call dropped.", action: "retry" }, server: null })).toEqual({ kind: "notice", text: "Call dropped.", action: "retry" });
    expect(liveCallBarView({ bot, media: { ...idle, phase: "failed", botId: "b1", threadId: "t1", notice: "The app didn't let this page use the microphone.", action: "open-in-browser" }, server: null })).toEqual({ kind: "notice", text: "The app didn't let this page use the microphone.", action: "open-in-browser" });
    expect(liveCallBarView({ bot, media: { ...idle, phase: "failed", botId: "b1", threadId: "t1", notice: "Another Live call is running.", action: null }, server: null })).toEqual({ kind: "notice", text: "Another Live call is running.", action: null });
    expect(liveCallBarView({ bot, media: { ...idle, phase: "ended", botId: "b1", threadId: "t1", notice: "Call ended.", action: "retry" }, server: null })).toEqual({ kind: "notice", text: "Call ended.", action: null });
  });
});

describe("hangUpRemoteCall", () => {
  it("leaves the bar to the harness's end frame when the hang-up goes through", async () => {
    const request = vi.fn(async () => ({ call: { status: "ended" } }));
    const dispatch = vi.fn();
    await hangUpRemoteCall("c9", 3, dispatch, request as never);
    expect(request).toHaveBeenCalledWith("/api/live/call/end", { method: "POST", body: JSON.stringify({ callId: "c9" }) });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("takes the harness's real state when it no longer knows the call, unless a newer frame landed meanwhile", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/api/live/call/end") throw new Error("That call is not running.");
      return { call: null };
    });
    const dispatch = vi.fn();
    await hangUpRemoteCall("c9", 3, dispatch, request as never);
    expect(request).toHaveBeenLastCalledWith("/api/live/call");
    expect(dispatch).toHaveBeenCalledWith({ type: "liveCallLookup", call: null, since: 3, seq: expect.any(Number) });
  });
  it("stays quiet when the harness cannot be reached at all", async () => {
    const dispatch = vi.fn();
    await expect(hangUpRemoteCall("c9", 3, dispatch, (async () => { throw new Error("offline"); }) as never)).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("liveLineHeldElsewhere", () => {
  const phone = { callId: "c9", botId: "b2", threadId: "t2", client: "ios", voice: "marin", startedAt: 0, status: "live" } as const;
  it("is true while another device's call runs, on any bot, until it has ended", () => {
    expect(liveLineHeldElsewhere(idle, phone)).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...phone, status: "connecting" })).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...phone, status: "ending" })).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...(phone as object), status: "on-hold" } as unknown as typeof phone)).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...phone, status: "ended" })).toBe(false);
    expect(liveLineHeldElsewhere(idle, null)).toBe(false);
  });
  it("is false while this window holds a call: its own button rules apply", () => {
    const calling: LiveMediaState = { ...idle, phase: "starting", botId: "b1", threadId: "t1" };
    expect(liveLineHeldElsewhere(calling, phone)).toBe(false);
    expect(liveLineHeldElsewhere({ ...calling, phase: "live", callId: "c9" }, phone)).toBe(false);
  });
});
