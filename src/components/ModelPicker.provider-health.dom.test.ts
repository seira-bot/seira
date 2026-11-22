// @vitest-environment happy-dom
// The model picker puts the providers that can start a task before the ones that cannot, in both views.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { rememberLimits } from "@/lib/limit-resets";
import { setLocale, t } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ advanced: true, instances: [] as InstanceInfo[], bots: [] as Bot[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: fixture.bots, modelVariantSessions: {}, config: {} },
    dispatch: vi.fn(), refreshInstances: () => Promise.resolve(), refreshModels: () => Promise.resolve(),
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

const { ModelPicker } = await import("./ModelPicker");

const engine = (instanceId: string, displayName: string, snapshot: InstanceInfo["snapshot"] = { state: "available", version: "1", authenticated: true }): InstanceInfo => ({
  instanceId, driverKind: instanceId === "codex" ? "codex" : "cursorAgent", displayName, access: "subscription", snapshot,
  models: { default: `${instanceId}-model`, options: [{ id: `${instanceId}-model`, label: `${displayName} model` }] },
});
const cursor = (snapshot?: InstanceInfo["snapshot"]) => engine("cursor", "Cursor", snapshot);
const codex = () => engine("codex", "Codex");
const grok = () => engine("grok", "Grok");
const bot = (instanceId: string): Bot => ({
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId, model: `${instanceId}-model` },
});

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const open = async (forBot: Bot) => {
  flushSync(() => root.render(createElement(ModelPicker, { bot: forBot, threadId: forBot.threadId })));
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-tour="model"]')!.click());
  await settle();
};
const railButtons = () => [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed][title]")];

beforeEach(() => {
  setLocale("en");
  fixture.advanced = true;
  fixture.bots = [];
  rememberLimits({ checkedAt: 1, engines: [] });
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("the model picker's provider rail", () => {
  it("lists a provider that needs a sign-in after the ones that work, dimmed, with the reason in its title", async () => {
    fixture.instances = [cursor({ state: "available", version: "1", authenticated: false }), codex()];
    await open(bot("codex"));
    const buttons = railButtons();
    const unusable = document.querySelector<HTMLButtonElement>("[data-rail-unusable]")!;
    expect(unusable.title).toBe(`Cursor · ${t("model.signInRequired")}`);
    expect(unusable.className).toContain("opacity-40");
    expect(buttons.at(-1)).toBe(unusable);
    expect(buttons.slice(0, -1).some((button) => button.hasAttribute("data-rail-unusable"))).toBe(false);
    const heading = document.querySelector("[data-rail-not-ready]")!;
    expect(heading.textContent).toBe(t("model.rail.notReady"));
    expect(heading.compareDocumentPosition(unusable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists a provider at its usage limit the same way", async () => {
    rememberLimits({ checkedAt: 1, engines: [{ engine: "grok", name: "Grok", driver: "grok", window: "5-hour", usedPercent: 100, resetsAt: null, blocked: true, windows: [] }] });
    fixture.instances = [grok(), codex()];
    await open(bot("codex"));
    const unusable = [...document.querySelectorAll<HTMLButtonElement>("[data-rail-unusable]")];
    expect(unusable.map((button) => button.title)).toEqual([`Grok · ${t("limits.atLimit", { engine: "Grok" })}`]);
    expect(railButtons().at(-1)).toBe(unusable[0]);
  });

  it("lists the provider the bot uses last when its CLI is missing", async () => {
    fixture.instances = [cursor({ state: "unavailable", reason: "CLI not found" }), codex()];
    await open(bot("cursor"));
    const unusable = document.querySelector<HTMLButtonElement>("[data-rail-unusable]")!;
    expect(unusable.title).toBe(`Cursor · ${t("model.setupRequired")}`);
    expect(railButtons().at(-1)).toBe(unusable);
  });

  it("opens on the first provider that works when the bot's own is gone, and never on one that does not", async () => {
    fixture.instances = [cursor({ state: "available", version: "1", authenticated: false }), codex()];
    await open(bot("missing"));
    const pressed = railButtons().filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.hasAttribute("data-rail-unusable")).toBe(false);
    expect(document.querySelector("[data-model-picker-content]")?.textContent).toContain("Codex model");
    expect(document.querySelector("[data-model-picker-content]")?.textContent).not.toContain("Cursor model");
  });

  it("keeps a provider that only has a CLI update among the ones that work", async () => {
    fixture.instances = [engine("cursor", "Cursor", { state: "available", version: "1", authenticated: true, update: { title: "Update", message: "A newer version is out." } }), codex()];
    await open(bot("codex"));
    expect(document.querySelector("[data-rail-unusable]")).toBeNull();
    expect(document.querySelector("[data-rail-not-ready]")).toBeNull();
  });
});

describe("the Simple model menu", () => {
  it("lists the providers that work first and dims the others, with the reason", async () => {
    fixture.advanced = false;
    fixture.instances = [cursor({ state: "available", version: "1", authenticated: false }), codex()];
    await open(bot("cursor"));
    const groups = [...document.querySelectorAll<HTMLElement>("[data-simple-provider]")];
    expect(groups.map((group) => group.getAttribute("data-simple-provider"))).toEqual(["codex", "cursor"]);
    expect(groups[0]!.hasAttribute("data-simple-unusable")).toBe(false);
    expect(groups[1]!.hasAttribute("data-simple-unusable")).toBe(true);
    expect(groups[1]!.title).toBe(t("model.signInRequired"));
  });
});

describe("the provider menu", () => {
  const menuIn = (scope: Element) => scope.querySelector('[data-provider-menu] button[aria-haspopup="menu"]') as HTMLButtonElement | null;
  const itemsOf = (button: HTMLButtonElement) => {
    flushSync(() => button.click());
    return [...document.body.querySelectorAll('[data-provider-floating] [role="menuitem"]')].map((item) => item.textContent);
  };

  it("offers the same Hide in the full view and in the Simple view", async () => {
    fixture.instances = [codex(), grok()];
    await open(bot("codex"));
    const full = itemsOf(menuIn(document.querySelector("[data-model-picker-content]")!)!);
    flushSync(() => root.unmount());
    root = createRoot(host);
    fixture.advanced = false;
    await open(bot("grok"));
    const simple = itemsOf(menuIn(document.querySelector('[data-simple-provider="codex"]')!)!);
    expect(full).toEqual([t("engines.hide")]);
    expect(simple).toEqual(full);
  });

  it("names the bots that use the provider and offers to move them to one that works", async () => {
    fixture.advanced = false;
    fixture.instances = [codex(), grok()];
    fixture.bots = [bot("codex")];
    await open(bot("grok"));
    const button = menuIn(document.querySelector('[data-simple-provider="codex"]')!)!;
    itemsOf(button);
    const menu = document.body.querySelector("[data-provider-floating]")!;
    expect(menu.querySelector("[data-provider-used]")?.textContent).toBe(t("provider.usedBy", { count: "1" }));
    expect(menu.querySelector("[data-provider-move]")?.textContent).toBe(t("provider.moveAndHide", { count: "1", target: "Grok" }));
    expect(menu.querySelector("[data-provider-hide]")).toBeNull();
  });

  describe("where it opens", () => {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const floating = () => document.body.querySelector<HTMLElement>("[data-provider-floating]");
    const lastGroupButton = () => document.querySelector<HTMLButtonElement>('[data-simple-provider="cursor"] button[aria-haspopup="menu"]')!;
    const key = (target: Element, name: string) => flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
    const press = (target: Element) => flushSync(() => target.dispatchEvent(new Event("pointerdown", { bubbles: true })));

    afterEach(() => vi.restoreAllMocks());
    beforeEach(async () => {
      Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-provider-floating")) return rect(300, 0, 260, 150);
        if (this === lastGroupButton()) return rect(500, 770, 24, 24);
        return rect(0, 0, 0, 0);
      });
      fixture.advanced = false;
      fixture.instances = [codex(), grok(), cursor()];
      await open(bot("codex"));
    });

    it("opens inside the window above the button of the last group, outside the scrolling list", () => {
      flushSync(() => lastGroupButton().click());
      const panel = floating()!;
      expect(panel.parentElement).toBe(document.body);
      expect(document.querySelector("[data-simple-model-menu]")!.contains(panel)).toBe(false);
      expect(panel.style.position).toBe("fixed");
      expect(parseFloat(panel.style.top)).toBeLessThan(770);
      expect(parseFloat(panel.style.top) + 150).toBeLessThanOrEqual(800);
      expect(panel.querySelector('[role="menu"]')).not.toBeNull();
    });

    it("closes on Escape and on a press outside, and stays open for a press inside", () => {
      flushSync(() => lastGroupButton().click());
      press(floating()!.querySelector('[role="menu"]')!);
      expect(floating()).not.toBeNull();
      key(floating()!, "Escape");
      expect(floating()).toBeNull();
      expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
      flushSync(() => lastGroupButton().click());
      press(document.querySelector("[data-simple-model-menu]")!);
      expect(floating()).toBeNull();
      expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    });
  });
});
