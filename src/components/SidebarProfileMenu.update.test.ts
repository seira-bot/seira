import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ update: { status: "idle" } as UpdaterState }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {}, routines: [], webhooks: [], routineRuns: [], bots: [] }, dispatch: vi.fn() }) }));
vi.mock("@/lib/updater", async (original) => ({ ...(await original<typeof import("@/lib/updater")>()), useUpdaterState: () => fixture.update }));
vi.mock("./SidebarPhoneButton", () => ({ useSidebarPhoneStatus: () => ({ kind: "unavailable" }) }));

import { SidebarProfileMenu, updateLabel, updatePhase, upToDateAfterClick } from "./SidebarProfileMenu";

beforeEach(() => { vi.stubGlobal("window", { ogb: { updater: {} } }); });
afterEach(() => { vi.unstubAllGlobals(); });

it.each([false, true])("keeps update progress on the separate button, iconOnly=%s", (iconOnly) => {
  for (const status of ["idle", "checking", "downloading", "preparing", "downloaded", "installing"] as const) {
    fixture.update = { status };
    const html = renderToStaticMarkup(createElement<{ iconOnly: boolean }>(SidebarProfileMenu, { iconOnly }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toMatch(/bg-(accent|danger)\//);
    expect(html).not.toContain("ring-2 ring-app");
  }
});

it.each([false, true])("retains error attention when no separate update button is shown, iconOnly=%s", (iconOnly) => {
  fixture.update = { status: "error", message: "Fixture update failed" };
  const html = renderToStaticMarkup(createElement<{ iconOnly: boolean }>(SidebarProfileMenu, { iconOnly }));
  expect(html).toContain("bg-danger");
  if (!iconOnly) expect(html).toContain('aria-label="Fixture update failed"');
});

it("says up to date only when a check finished after the click", () => {
  const clicked = 10_000;
  expect(upToDateAfterClick({ status: "idle", upToDateAt: clicked + 200 }, clicked, clicked + 500)).toBe(true);
  expect(upToDateAfterClick({ status: "idle", upToDateAt: clicked - 5 }, clicked, clicked + 500)).toBe(false);
  expect(upToDateAfterClick({ status: "idle" }, clicked, clicked + 500)).toBe(false);
  expect(upToDateAfterClick({ status: "idle", checkFailedAt: clicked + 100 }, clicked, clicked + 500)).toBe(false);
  expect(upToDateAfterClick({ status: "idle", downloadOnly: true }, clicked, clicked + 500)).toBe(false);
  expect(upToDateAfterClick(null, clicked, clicked + 500)).toBe(false);
  expect(upToDateAfterClick({ status: "idle", upToDateAt: clicked + 200 }, 0, clicked + 500)).toBe(false);
  expect(upToDateAfterClick({ status: "idle", upToDateAt: clicked + 200 }, clicked, clicked + 4000)).toBe(false);
});

it("words a download-only copy's row as a way to the newest version", () => {
  const state: UpdaterState = { status: "idle", downloadOnly: true };
  expect(updateLabel(updatePhase(state, false), state)).toBe("Get the newest version");
  expect(updateLabel(updatePhase({ status: "idle" }, false), { status: "idle" })).toBe("Check for updates");
});
