// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { fullContext } from "../settings-index";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";

vi.mock("../../PeopleSection", () => ({ PeopleSection: () => createElement("div", { "data-people-section": "" }) }));
vi.mock("../../bot-access/AccessOverview", () => ({ AccessOverview: () => null }));
const { PeoplePage } = await import("./DataPages");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

async function show(over: Parameters<typeof fullContext>[0]) {
  const shell = { ctx: fullContext(over) } as unknown as SettingsShell;
  root = createRoot(host);
  await act(async () => { root!.render(createElement(SettingsShellContext.Provider, { value: shell }, createElement(PeoplePage))); });
}

it("AC-E1 shows the members block on a connected server's page in the desktop window", async () => {
  await show({ desktop: true, here: false, admin: true, cloud: false });
  expect(host.querySelector("[data-people-section]")).not.toBeNull();
});

it("AC-E3 shows no members block on the desktop app's own computer", async () => {
  await show({ desktop: true, here: true, admin: true, cloud: false });
  expect(host.querySelector("[data-people-section]")).toBeNull();
});
