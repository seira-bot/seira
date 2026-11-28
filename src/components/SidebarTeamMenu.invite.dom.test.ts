// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { config: null, bots: [], groups: [] }, dispatch: vi.fn() }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
import { TeamMenuItems } from "./SidebarTeamMenu";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const menu = (onInvite?: () => void) => createElement(TeamMenuItems, { department: "Sales", onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn(), onInvite });

it("AC-20 offers Invite to this department and calls the handler when it is chosen", async () => {
  const onInvite = vi.fn();
  await act(async () => root.render(menu(onInvite)));
  const entry = container.querySelector<HTMLButtonElement>("[data-team-invite]")!;
  expect(entry.textContent).toBe("Invite to this department");
  expect(entry.getAttribute("role")).toBe("menuitem");
  await act(async () => entry.click());
  expect(onInvite).toHaveBeenCalledTimes(1);
});

it("AC-23 leaves the entry out when the app does not offer inviting", async () => {
  await act(async () => root.render(menu()));
  expect(container.textContent).not.toContain("Invite to this department");
});
