// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";

const openComputer = vi.fn();
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...(await original<typeof import("@/state/store")>()), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
vi.mock("../account-summary", async (original) => ({
  ...(await original<typeof import("../account-summary")>()),
  useAccountSummary: () => ({ signedIn: true, email: null, plan: null, paid: false }),
  useYou: () => ({ profile: undefined, session: null }),
}));
vi.mock("../inert", async (original) => ({ ...(await original<typeof import("../inert")>()), useSwitchToComputer: () => ({ name: "This computer", open: openComputer }) }));
const { AccountPage } = await import("./AccountPages");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const open = vi.fn(async () => undefined);
const shell = {
  ctx: { desktop: true, client: false, here: false, home: false, advanced: false, organization: false },
  place: { kind: "cloud", name: "Acme", color: null }, go: vi.fn(), page: "account",
} as unknown as SettingsShell;

async function render(offered: boolean) {
  Object.assign(window, { ogb: { accountSheet: { offered: vi.fn(async () => offered), open } } });
  root = createRoot(host);
  await act(async () => { root!.render(createElement(SettingsShellContext.Provider, { value: shell }, createElement(AccountPage))); });
  return host.querySelector('[data-settings-block="seira-account"]') ?? host;
}

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); document.body.innerHTML = ""; delete (window as { ogb?: unknown }).ogb; });

it("a team Cloud's page that main offers the sheet for: Account and sign out opens it here, with no trip to This computer", async () => {
  const card = await render(true);
  expect(card.querySelector("[data-account-elsewhere]")).toBeNull();
  await act(async () => { card.querySelector<HTMLElement>("[data-account-manage]")!.click(); });
  expect(open).toHaveBeenCalledOnce();
  expect(openComputer).not.toHaveBeenCalled();
});

it("a page main doesn't offer the sheet for shows no dead row, only the way to This computer", async () => {
  const card = await render(false);
  expect(card.querySelector("[data-account-manage]")).toBeNull();
  await act(async () => { card.querySelector<HTMLElement>("[data-account-elsewhere]")!.click(); });
  expect(openComputer).toHaveBeenCalledOnce();
});

it("without an address to show, the card says Signed in once", async () => {
  const card = await render(true);
  expect(card.textContent!.match(/Signed in/g)).toHaveLength(1);
});
