// A turn that ran without its cloud desktop says so in a neutral note: no red, no Retry, in a chat and in a room.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
import { placeRowText, type PlaceRow } from "../../shared/place-view";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn(), advanced: false, ownerOrAdmin: null as boolean | null, bots: [] as Bot[], config: {} as Record<string, unknown> };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config, instances: [] as InstanceInfo[], bots: fixture.bots },
    dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedTurnRow } = await import("./ChatView");
const { RoomToolChip } = await import("./GroupView");


const note: PlaceRow = { state: "cc-not-set-up", params: { bot: "Scout" }, source: "works-on" };
const notice = (place: PlaceRow = note): NonNullable<Message["tool"]> => failedTurnTool(placeRowText(place), { place, notice: true });
const failedPlace = (place: PlaceRow = note): NonNullable<Message["tool"]> => failedTurnTool(placeRowText(place), { place });

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.advanced = false;
  fixture.ownerOrAdmin = null;
  fixture.config = {};
  fixture.bots = [{ id: "scout", name: "Scout", computer: "cloud", modelSelection: { instanceId: "claude", model: "m" } } as Bot];
});

const chat = (tool: NonNullable<Message["tool"]>, onRetry?: () => void) =>
  renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine: undefined, botId: "scout", threadId: "thread-scout", onRetry }));
const room = (tool: NonNullable<Message["tool"]>) => renderToStaticMarkup(createElement(RoomToolChip, {
  message: { id: "n", role: "bot", kind: "activity", at: 1, from: { botId: "scout", name: "Scout", color: "blue" }, tool } as Message, roomId: "room",
}));

describe("the notice a turn leaves when no cloud desktop is set up", () => {
  it("is a neutral note in a chat: the words and the one way on, no error styling, no Retry", () => {
    const html = chat(notice(), vi.fn());
    expect(html).toContain('role="note"');
    expect(html).toContain("answered without a computer because no cloud desktop is set up");
    expect(html).not.toMatch(/boat/i);
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/danger|red-/);
    expect(html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).toHaveLength(1);
  });

  it("is the same note in a room", () => {
    const html = room(notice({ ...note, source: "room" }));
    expect(html).toContain('role="note"');
    expect(html).toContain("answered without a computer because no cloud desktop is set up");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain('role="alert"');
  });

  it("does not turn the same place row into a note when the turn did fail", () => {
    const html = chat(failedPlace(), vi.fn());
    expect(html).not.toContain('role="note"');
  });
});
