// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../../cloud-buy/CloudMascotScene", () => ({ CloudMascotScene: () => null }));
vi.mock("../settings-context", async (original) => ({ ...(await original<typeof import("../settings-context")>()), useOtherPlaces: () => [] }));
const { PlacesFromHere } = await import("./AppPages");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const add = vi.fn();
beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  Object.assign(window, { ogb: { workspaces: { add, probe: vi.fn(async () => ({ outcome: "problem", problem: "unreachable", host: "" })) } } });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); document.body.innerHTML = ""; });

it("Settings' Connect to a server opens the sheet that takes a link, or an address and a code", async () => {
  const shell = { place: { kind: "computer", name: "This computer" } } as unknown as SettingsShell;
  root = createRoot(host);
  await act(async () => { root!.render(createElement(SettingsShellContext.Provider, { value: shell }, createElement(PlacesFromHere))); });
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-server-connect]")!.click(); });
  const form = document.querySelector('[data-place-add="own-server"]')!;
  expect(form.querySelector("[data-own-server-link]")).not.toBeNull();
  expect(add).not.toHaveBeenCalled();
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector("[data-place-add-sheet]"), "Escape: no dead end").toBeNull();
});
