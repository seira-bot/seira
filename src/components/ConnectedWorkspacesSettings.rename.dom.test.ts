// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: () => {} }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const { ConnectedWorkspacesSettings } = await import("./ConnectedWorkspacesSettings");

const VPS = { id: "vps", name: "VPS", origin: "https://bots.example.test", kind: "remote" as const };
const listed = (environments: unknown[]) => ({ localOrigin: "http://127.0.0.1:1", remote: false, activeId: "local", environments });

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("reads the list again when the renamed server is gone, so its row leaves", async () => {
  const environments = {
    state: vi.fn().mockResolvedValueOnce(listed([VPS])).mockResolvedValue(listed([])),
    rename: vi.fn().mockResolvedValue({ outcome: "gone" }),
    switch: vi.fn(), forget: vi.fn(), addFromLink: vi.fn(), onOpenSettings: () => () => {},
  };
  vi.stubGlobal("ogb", { environments });
  await act(async () => { root.render(createElement(ConnectedWorkspacesSettings)); });
  const row = () => host.querySelector('[data-server-row="vps"]');
  await vi.waitFor(() => expect(row()).not.toBeNull());

  await act(async () => { row()!.querySelector<HTMLButtonElement>('[data-server-rename="vps"]')!.click(); });
  const field = row()!.querySelector<HTMLInputElement>("[data-server-rename-form] input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Studio");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { row()!.querySelector<HTMLFormElement>("[data-server-rename-form]")!.requestSubmit(); });

  await vi.waitFor(() => expect(row()).toBeNull());
  expect(environments.rename).toHaveBeenCalledWith("vps", "Studio");
  expect(environments.state).toHaveBeenCalledTimes(2);
});
