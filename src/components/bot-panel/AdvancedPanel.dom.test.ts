// @vitest-environment happy-dom
// The Advanced bot panel in a real DOM: hero, quick actions, grouped rows with their values, search and the open section.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  openComputer: vi.fn(),
  storeState: {} as Record<string, unknown>,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, settingsOpen: true, ...fixture.storeState }, dispatch: fixture.dispatch, flushBotPatches: () => Promise.resolve(null) }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, readAdvancedMode: () => true, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("../bot-access/ShareBotButton", () => ({ ShareBotButton: () => null, useTeamName: () => null }));
vi.mock("../bot-settings/useBotSettingsDerived", () => ({
  useBotSettingsDerived: () => ({
    patch: vi.fn(),
    engine: { instanceId: "claude", models: { options: [{ id: "claude-opus-5-5", label: "Opus 5.5" }] } },
    approvalMode: "ask",
    activeBotRoutines: 2,
    activeState: "idle",
  }),
}));
vi.mock("../bot-settings/useSlackManagement", () => ({ useSlackManagementUrl: () => null }));
vi.mock("../bot-settings/useBotApps", () => ({ useBotApps: () => ({ phase: "ready", apps: [], connectedSlugs: [], inventorySettled: true, cardsSettled: true, emailSettled: true }) }));
vi.mock("../bot-settings/MemorySection", () => ({ MemorySection: () => createElement("div", { "data-stub": "memory" }) }));
vi.mock("../bot-settings/SkillsSection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../bot-settings/SkillsSection")>(),
  useManagedSkills: () => ({ skills: [{ name: "a", enabled: true }, { name: "b", enabled: true }], loading: false }),
  skillSwitchOn: (skill: { enabled?: boolean }) => skill.enabled === true,
}));
vi.mock("../bot-settings/useBotOverview", () => ({
  useBotOverview: () => ({ overview: null, overviewError: false, prompt: null, promptError: false }),
  useBotHistory: () => ({ rows: null, error: false, revision: null, rollingBack: false }),
  HistoryRollbackDialog: () => null,
}));
vi.mock("./use-memory-doc", () => ({ useMemoryDoc: () => ({ docs: null, error: true, mine: false, setDoc: vi.fn(), reload: vi.fn() }) }));
vi.mock("./ComputerTab", () => ({
  usePlaceChoices: () => ({ currentLabel: "This computer" }),
  useOpenComputer: () => fixture.openComputer,
}));
vi.mock("./LibraryTab", () => ({
  libraryItems: () => ({ pages: [{ url: "u" }], apps: [], shared: [], unshared: ["a", "b"] }),
  LibraryTab: () => null,
}));
vi.mock("../ModelPicker", () => ({ effortLabel: (level: string) => level[0]!.toUpperCase() + level.slice(1) }));
vi.mock("../bot-settings/SoulSection", () => ({ SoulSection: () => createElement("div", { "data-stub": "soul" }) }));
vi.mock("../bot-settings/ModelSection", () => ({ ModelSection: () => createElement("div", { "data-stub": "model" }) }));

const { BotSettingsDialog } = await import("../BotSettingsDialog");

const bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [], chiefOfStaff: true,
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
} as unknown as Bot;

let host: HTMLDivElement;
let root: Root;
const render = (state: Record<string, unknown> = {}) => {
  fixture.storeState = state;
  flushSync(() => root.render(createElement(BotSettingsDialog, { bot })));
};
const row = (id: string) => host.querySelector<HTMLElement>(`[data-bot-settings-section="${id}"]`)!;
const rowButton = (id: string) => row(id).querySelector<HTMLButtonElement>("button")!;
const search = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
const type = (value: string) => {
  const input = search();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  flushSync(() => { input.dispatchEvent(new Event("input", { bubbles: true })); });
};

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.openComputer.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("the Advanced panel", () => {
  it("shows the bot's name, role and a close button in the hero", () => {
    const title = host.querySelector("#bot-settings-title")!;
    expect(title.textContent).toBe("Scout");
    expect(host.querySelector("[data-advanced-hero]")!.textContent).toContain("Researcher");
    expect(host.querySelector("[data-advanced-hero]")!.textContent).toContain("Chief of Staff");
  });

  it("offers Message, Screen, Routines and Settings", () => {
    const labels = [...host.querySelectorAll("[data-panel-quick-action]")].map((node) => node.textContent);
    expect(labels).toEqual(["Message", "Screen", "Routines", "Settings"]);
  });

  it("opens the screen, and opens the Routines and Overview sections", () => {
    host.querySelector<HTMLElement>('[data-panel-quick-action="computer"]')!.click();
    expect(fixture.openComputer).toHaveBeenCalledTimes(1);
    host.querySelector<HTMLElement>('[data-panel-quick-action="routines"]')!.click();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "routines" });
    host.querySelector<HTMLElement>('[data-panel-quick-action="settings"]')!.click();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "overview" });
  });

  it("groups every section in order and keeps all of them reachable", () => {
    const groups = [...host.querySelectorAll("[data-advanced-group]")].map((group) => [
      group.querySelector("h3")!.textContent,
      [...group.querySelectorAll("[data-bot-settings-section]")].map((item) => item.getAttribute("data-bot-settings-section")),
    ]);
    expect(groups).toEqual([
      ["Profile", ["overview", "identity", "soul"]],
      ["Knowledge", ["skills", "memory", "library"]],
      ["Work", ["routines", "model", "permissions", "access"]],
      ["Channels", ["voice"]],
      ["Admin", ["visibility", "history", "usage"]],
    ]);
  });

  it("writes a value beside the rows that can state one, and none beside the rest", () => {
    const value = (id: string) => row(id).querySelector("button")!.querySelectorAll("span")[1]?.className.includes("tabular-nums")
      ? row(id).querySelector("button")!.querySelectorAll("span")[1]!.textContent : null;
    expect(value("identity")).toBe("Researcher");
    expect(value("skills")).toBe("2 on");
    expect(value("memory")).toBe("Nothing yet");
    expect(value("library")).toBe("3 items");
    expect(value("routines")).toBe("2 on");
    expect(value("model")).toBe("Opus 5.5 · High");
    expect(value("access")).toBe("This computer");
    expect(value("voice")).toBe("On");
    expect(value("overview")).toBeNull();
    expect(value("soul")).toBeNull();
    expect(value("history")).toBeNull();
    expect(value("usage")).toBeNull();
  });

  it("makes each row a button that opens its own section, one at a time", () => {
    for (const id of ["overview", "model", "permissions", "usage"]) {
      expect(rowButton(id).getAttribute("aria-expanded")).toBe("false");
      rowButton(id).click();
      expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: id });
    }
    render({ botSettingsSection: "model", botSettingsExpandAccordion: true });
    expect(rowButton("model").getAttribute("aria-expanded")).toBe("true");
    expect(rowButton("soul").getAttribute("aria-expanded")).toBe("false");
    expect(row("model").querySelector('[role="region"]')).not.toBeNull();
    expect(row("soul").querySelector('[role="region"]')).toBeNull();
    rowButton("model").click();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true });
  });

  it("marks an open section body as the Advanced scope, and no other part of the panel", () => {
    expect(host.querySelectorAll("[data-advanced-body]")).toHaveLength(1);
    expect(host.querySelector("[data-advanced-body]")!.id).toBe("bot-settings-body-memory");
    render({ botSettingsSection: "model", botSettingsExpandAccordion: true });
    const scoped = [...host.querySelectorAll("[data-advanced-body]")].map((node) => node.id);
    expect(scoped).toEqual(["bot-settings-body-memory", "bot-settings-body-model"]);
    expect(row("model").contains(host.querySelector("#bot-settings-body-model"))).toBe(true);
    expect(host.querySelector("[data-advanced-hero]")!.closest("[data-advanced-body]")).toBeNull();
  });

  it("filters the rows as you search and hides a group with no match", () => {
    type("provider");
    const shown = [...host.querySelectorAll<HTMLElement>("[data-bot-settings-section]")].filter((node) => !node.hidden).map((node) => node.dataset.botSettingsSection);
    expect(shown).toEqual(["model"]);
    const hidden = [...host.querySelectorAll<HTMLElement>("[data-advanced-group]")].filter((node) => node.hidden).map((node) => node.dataset.advancedGroup);
    expect(hidden).toEqual(["profile", "knowledge", "channels", "admin"]);
  });

  it("says when no setting matches", () => {
    type("zzzz");
    expect(host.textContent).toContain("No settings match “zzzz”");
    expect([...host.querySelectorAll<HTMLElement>("[data-advanced-group]")].every((node) => node.hidden)).toBe(true);
  });
});
