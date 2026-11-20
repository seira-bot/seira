import { createElement, type MemoExoticComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot, type InstanceInfo } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState>, advanced: true }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: vi.fn() }) };
});

import { BotModelBadge, botModel } from "./BotModelBadge";
import { BotListItem, botRowProps, type BotRowProps } from "./Sidebar";

const claude = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" },
  models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet 4.5" }, { id: "opus", label: "Opus 4.1" }] },
} as InstanceInfo;
const bot = (instanceId: string, model: string): Bot => ({
  id: "atlas", threadId: "t", name: "Atlas", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId, model },
});

describe("botModel", () => {
  it("names the bot's chosen model by its picker label", () => {
    expect(botModel(bot("claude", "opus"), [claude])).toEqual({ instance: claude, id: "opus", label: "Opus 4.1" });
  });

  it("names the engine's default model when the bot has not chosen one", () => {
    expect(botModel(bot("claude", ""), [claude])?.label).toBe("Sonnet 4.5");
  });

  it("falls back to the raw id of a model the engine does not list", () => {
    expect(botModel(bot("claude", "claude-custom-7"), [claude])?.label).toBe("claude-custom-7");
  });

  it("finds nothing for an engine that is not installed", () => {
    expect(botModel(bot("gone", "opus"), [claude])).toBeNull();
  });
});

describe("BotModelBadge", () => {
  it("draws the engine mark, names only the model on hover and the engine too for screen readers", () => {
    const markup = renderToStaticMarkup(createElement(BotModelBadge, { bot: bot("claude", "opus"), instances: [claude], avatarSize: 44 }));
    expect(markup).toContain('data-testid="model-badge"');
    expect(markup).toContain('aria-label="Model: Opus 4.1 (Claude)"');
    expect(markup).toContain('title="Opus 4.1"');
    expect(markup).toContain("<svg");
  });

  const mark = (model: string) => renderToStaticMarkup(createElement(BotModelBadge, { bot: bot("claude", model), instances: [claude], avatarSize: 44 }));

  it("draws the OpenAI mark for a GPT model on the Claude engine", () => {
    const markup = mark("gpt-5");
    expect(markup).toContain('viewBox="0 0 256 260"');
    expect(markup).not.toContain("#d97757");
  });

  it("draws the Claude mark for the engine's own default model", () => {
    const markup = mark("");
    expect(markup).toContain("#d97757");
    expect(markup).not.toContain('viewBox="0 0 256 260"');
  });

  it("falls back to the engine's mark for a model of an unknown family", () => {
    const markup = mark("glm-4.6");
    expect(markup).toContain("#d97757");
    expect(markup).not.toContain('viewBox="0 0 256 260"');
  });

  it("draws nothing for an engine that is not installed", () => {
    expect(renderToStaticMarkup(createElement(BotModelBadge, { bot: bot("gone", "opus"), instances: [claude], avatarSize: 44 }))).toBe("");
  });
});

describe("sidebar bot row", () => {
  const botRow = (BotListItem as MemoExoticComponent<(props: BotRowProps) => ReactNode>).type;
  const render = (candidate: Bot, density: SidebarDensity) => renderToStaticMarkup(createElement(botRow,
    botRowProps({ ...initialState, ...fixture.state }, vi.fn(), candidate, { density, query: "", onMenu: vi.fn() })));
  const badges = (markup: string) => markup.match(/<span data-testid="model-badge"[^>]*>/g) ?? [];

  beforeEach(() => {
    fixture.state = { bots: [bot("claude", "opus")], instances: [claude], activeView: "chat", selectedId: "other" };
    fixture.advanced = true;
    vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("HTMLInputElement", class {});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the model once on the icon rail's avatar, clear of the status dot", () => {
    const found = badges(render(bot("claude", "opus"), "icons"));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('aria-label="Model: Opus 4.1 (Claude)"');
    expect(found[0]).toContain("absolute -bottom-0.5 -left-0.5");
  });

  it("keeps an Advanced row's avatar to its status dot and names the model in the name's tooltip", () => {
    const markup = render(bot("claude", "opus"), "comfortable");
    expect(badges(markup)).toHaveLength(0);
    expect(markup).not.toContain("data-provider-mark");
    expect(markup).toContain('title="Atlas · Model: Opus 4.1 (Claude)"');
  });

  // Simple mode shows the mark too (the owner's ask, 2026-10-22): a person sees which provider each bot runs on at a glance.
  it.each<SidebarDensity>(["comfortable", "icons"])("shows the model once in a Simple mode %s row", (density) => {
    fixture.advanced = false;
    const found = badges(render(bot("claude", "opus"), density));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('aria-label="Model: Opus 4.1 (Claude)"');
  });

  it("shows no badge while the bot's engine is missing", () => {
    expect(render(bot("gone", "opus"), "comfortable")).not.toContain('data-testid="model-badge"');
  });
});
