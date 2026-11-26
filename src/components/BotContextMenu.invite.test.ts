import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ advanced: true }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("react-dom", async (importOriginal) => ({ ...await importOriginal<typeof import("react-dom")>(), createPortal: (node: ReactNode) => node }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [scout] }, dispatch: vi.fn() }) };
});

const { BotContextMenu } = await import("./Sidebar");
const scout = { threadId: "thread", title: "", description: "", notifications: true, color: "green", unread: false, messages: [], modelSelection: { instanceId: "test", model: "test" }, id: "scout", name: "Scout", tasks: [{ threadId: "thread", title: "a" }] } as unknown as Bot;

beforeEach(() => {
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("window", { innerWidth: 1_000, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

const render = (onInvite?: (botId: string) => void) => renderToStaticMarkup(createElement(BotContextMenu, {
  menu: { botId: "scout", x: 10, y: 10 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(),
  onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(), onInvite,
}));

describe("Invite to this bot in a bot's menu", () => {
  for (const [layout, advanced] of [["Advanced", true], ["Simple", false]] as const) {
    it(`AC-21 is in the ${layout} menu when the app offers inviting`, () => {
      fixture.advanced = advanced;
      expect(render(vi.fn())).toContain("Invite to this bot");
    });

    it(`AC-23 is not in the ${layout} menu when the app does not offer inviting`, () => {
      fixture.advanced = advanced;
      expect(render()).not.toContain("Invite to this bot");
    });
  }
});
