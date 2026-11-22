import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: null as UpdaterState | null }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));
import { UpdatesRow } from "./AppSettingsRows";

afterEach(() => vi.unstubAllGlobals());
function render(state: UpdaterState | null) {
  fixture.state = state;
  vi.stubGlobal("window", { ogb: { updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() } } });
  return renderToStaticMarkup(createElement(UpdatesRow));
}

it("says nothing about updates on a page the desktop app doesn't answer, such as another server's", () => {
  expect(render(null)).toBe("");
});

it("shows this app's update where the desktop app answers, with no Download step", () => {
  expect(render({ status: "idle", upToDateAt: 1 })).toContain("Check for updates");
  const downloading = render({ status: "downloading", version: "0.2.0", percent: 40 });
  expect(downloading).toContain("Downloading 40%");
  expect(downloading).toContain("disabled");
  const ready = render({ status: "downloaded", version: "0.2.0" });
  expect(ready).toContain("Seira 0.2.0 is ready. Restart the app to apply it.");
  expect(ready).toContain("Restart and install");
  expect(render({ status: "downloaded", version: "0.2.0", installMode: "handoff" })).toContain("Seira 0.2.0 is ready. Install it in a terminal.");
});

it("offers no update action when an app store updates this install, and says so in plain words", () => {
  const html = render({ status: "idle", managedByStore: true });
  expect(html).toContain("Updates come with your package or store.");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("Check for updates");
});

it("says a check has not happened yet, and never claims the app is current", () => {
  const html = render({ status: "idle" });
  expect(html).toContain("Not checked yet.");
  expect(html).toContain("Check for updates");
  expect(html).not.toContain("latest version");
});

it("says the last check failed and offers another, instead of saying the app is current", () => {
  const html = render({ status: "idle", upToDateAt: undefined, checkFailedAt: 5 });
  expect(html).toContain("Couldn&#x27;t check for updates. Try again, or get the newest version from the website.");
  expect(html).toContain("Check for updates");
  expect(html).not.toContain("latest version");
  expect(render({ status: "idle", upToDateAt: 9, checkFailedAt: 5 })).toContain("You&#x27;re on the latest version we know of.");
});

it("sends a copy without its own updates to the website, with no check", () => {
  const html = render({ status: "idle", downloadOnly: true });
  expect(html).toContain("doesn&#x27;t update itself");
  expect(html).toContain("Download");
  expect(html).not.toContain("Check for updates");
  expect(html).not.toContain("latest version");
});
