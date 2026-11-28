// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const f = vi.hoisted(() => {
  const state = { worn: null as string | null, listeners: new Set<() => void>(), calls: [] as Array<{ path: string; init?: { method?: string; body?: string } }>, saved: [] as string[], fail: false };
  return state;
});
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    f.calls.push({ path, init });
    if (f.fail && init?.method) throw new Error("");
    if (path === "/api/themes") return { active: f.worn, themes: f.saved.map((id) => ({ id, name: id })) };
    if (path === "/api/themes/active" && init?.body) { f.worn = JSON.parse(init.body).id; f.saved.push(f.worn!); }
    if (path === "/api/themes/history") f.worn = null;
    return { ok: true };
  }),
}));
vi.mock("@/lib/theme/runtime", () => ({
  subscribeTheme: (listener: () => void) => { f.listeners.add(listener); return () => f.listeners.delete(listener); },
  wornTheme: () => (f.worn ? { id: f.worn, theme: {} } : null),
  wearTheme: () => {},
  loadTheme: async () => { for (const listener of f.listeners) listener(); },
}));

const { RichMessageRow, richRowKind } = await import("./RichMessageRow");

const SARI = { id: "sari", name: "Sari", description: "Rose and leaf green.", theme: { light: { canvas: "#fff7f8", accent: "#c2335a" }, dark: { canvas: "#1a1416", accent: "#e4577a" } } };
const row = { id: "m1", role: "bot", kind: "text", text: "A theme for you: Sari.", themeCard: SARI } as unknown as Message;

let host: HTMLDivElement;
let root: Root;
const q = (selector: string) => host.querySelector<HTMLButtonElement>(selector);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async (message: Message = row, room = false) => {
  await act(async () => { root.render(createElement(RichMessageRow, { botId: "kiwi", botName: "Kiwi", threadId: "t-kiwi", message, room })); });
  await settle();
};
const click = async (selector: string) => { await act(async () => { q(selector)!.click(); }); await settle(); };

beforeEach(() => {
  setLocale("en");
  f.worn = null; f.saved = []; f.calls = []; f.fail = false; f.listeners.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("ThemeCard", () => {
  it("draws a message with a theme card as a widget row", () => {
    expect(richRowKind(row)).toBe("widget");
  });

  it("shows both pictures and the three buttons", async () => {
    await render();
    expect(host.querySelector("[data-theme-card='sari']")!.textContent).toContain("Sari");
    expect(host.querySelector("[data-theme-card='sari']")!.textContent).toContain("Rose and leaf green.");
    expect(host.querySelectorAll("[data-theme-preview]")).toHaveLength(2);
    expect(host.querySelectorAll("[data-skin-preview]")).toHaveLength(2);
    expect(q("[data-theme-wear]")!.textContent).toBe("Wear it");
    expect(q("[data-theme-save]")!.textContent).toBe("Save");
    expect(q("[data-theme-another]")!.textContent).toBe("Try another");
    expect(host.querySelector("[data-theme-readable]")).not.toBeNull();
    expect(host.querySelector("[data-theme-status]")).toBeNull();
  });

  it("wears in one request, shows the status and Undo, and Undo goes one step back", async () => {
    await render();
    await click("[data-theme-wear]");
    const wear = f.calls.find((call) => call.path === "/api/themes/active")!;
    expect(wear.init!.method).toBe("PUT");
    expect(JSON.parse(wear.init!.body!)).toMatchObject({ id: "sari", theme: { name: "Sari" } });
    expect(q("[data-theme-wear]")!.textContent).toBe("Wearing it");
    expect(q("[data-theme-wear]")!.disabled).toBe(true);
    expect(q("[data-theme-save]")!.textContent).toBe("Saved to Yours");
    expect(host.querySelector("[data-theme-status]")!.textContent).toContain("Wearing Sari on every window.");
    await click("[data-theme-undo]");
    expect(JSON.parse(f.calls.find((call) => call.path === "/api/themes/history")!.init!.body!)).toEqual({ steps: 1 });
    expect(host.querySelector("[data-theme-status]")).toBeNull();
    expect(q("[data-theme-wear]")!.textContent).toBe("Wear it");
  });

  it("saves without wearing", async () => {
    await render();
    await click("[data-theme-save]");
    const put = f.calls.find((call) => call.path === "/api/themes/sari")!;
    expect(put.init!.method).toBe("PUT");
    expect(f.calls.some((call) => call.path === "/api/themes/active")).toBe(false);
    expect(q("[data-theme-save]")!.textContent).toBe("Saved to Yours");
    expect(q("[data-theme-wear]")!.textContent).toBe("Wear it");
  });

  it("asks the bot for another in the same conversation", async () => {
    await render();
    await click("[data-theme-another]");
    const sent = f.calls.find((call) => call.path === "/api/bots/kiwi/messages")!;
    expect(JSON.parse(sent.init!.body!)).toMatchObject({ threadId: "t-kiwi", text: "Try another theme like Sari." });
  });

  it("knows a saved and a worn theme after a reload, without a status line", async () => {
    f.saved = ["sari"];
    f.worn = "sari";
    await render();
    expect(q("[data-theme-wear]")!.textContent).toBe("Wearing it");
    expect(q("[data-theme-save]")!.textContent).toBe("Saved to Yours");
    expect(host.querySelector("[data-theme-status]")).toBeNull();
  });

  it("says in plain words when a request fails, and lets the person try again", async () => {
    await render();
    f.fail = true;
    await click("[data-theme-wear]");
    expect(host.querySelector("[data-theme-error]")!.textContent).toBe("That did not work. Try again.");
    expect(q("[data-theme-wear]")!.disabled).toBe(false);
    expect(host.querySelector("[data-theme-status]")).toBeNull();
  });

  it("is view-only in a room", async () => {
    await render(row, true);
    expect(q("[data-theme-wear]")!.disabled).toBe(true);
    expect(q("[data-theme-another]")).toBeNull();
  });

  it("shows the plain text when the colours do not fit", async () => {
    await render({ ...row, themeCard: { ...SARI, theme: { canvas: "red" } } } as unknown as Message);
    expect(host.textContent).toBe("A theme for you: Sari.");
  });
});
