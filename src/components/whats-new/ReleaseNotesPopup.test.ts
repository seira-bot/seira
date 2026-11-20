// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { RELEASE_NOTES, releaseNotesUrl, type ReleaseNotesView } from "@/lib/release-notes";

vi.mock("../seira-character", () => ({ SeiraCharacter: () => createElement("i", { "data-character": "happy" }) }));
const { ReleaseNotesPopup } = await import("./ReleaseNotesPopup");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const UPDATED: ReleaseNotesView = { version: "0.1.180", from: "0.1.179", items: [...RELEASE_NOTES[0]!.items] };
const TITLE = "What's new in Seira 0.1.180";

let host: HTMLDivElement, root: Root, opener: HTMLButtonElement, openExternal: ReturnType<typeof vi.fn>;
const props = { onDone: vi.fn(), onAllChanges: vi.fn() };
const show = async (view: ReleaseNotesView = UPDATED) => { await act(async () => { root.render(createElement(ReleaseNotesPopup, { view, ...props })); }); };
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name);
const click = async (name: string) => { const found = button(name); expect(found, name).toBeTruthy(); await act(async () => { found!.click(); }); };
const key = async (name: string, shiftKey = false) => {
  const event = new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return event;
};

beforeEach(() => {
  setLocale("en"); vi.clearAllMocks();
  opener = document.body.appendChild(document.createElement("button")); opener.textContent = "composer"; opener.focus();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  openExternal = vi.fn(async () => true);
  (window as { ogb?: unknown }).ogb = { openExternal };
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); delete (window as { ogb?: unknown }).ogb;
});

describe("the release notes popup", () => {
  it("is a modal dialog labelled by its title, with the version and four items", async () => {
    await show();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().getAttribute("data-release-notes")).toBe("0.1.180");
    expect(document.getElementById(dialog().getAttribute("aria-labelledby")!)!.textContent).toBe(TITLE);
    expect(host.querySelectorAll("li")).toHaveLength(4);
    expect(host.textContent).toContain("Report a problem in one step");
    expect(host.textContent).toContain("A safer yes in a Live call");
  });

  it("says where the update came from only when it knows", async () => {
    await show();
    expect(host.textContent).toContain("Updated from 0.1.179");
    await show({ ...UPDATED, from: null });
    expect(host.textContent).not.toContain("Updated from");
  });

  it("starts focus on Continue and keeps Tab inside", async () => {
    await show();
    expect(document.activeElement).toBe(button("Continue"));
    const order: Array<string | null> = [];
    for (let i = 0; i < 4; i++) { expect((await key("Tab")).defaultPrevented).toBe(true); order.push(document.activeElement!.textContent || document.activeElement!.getAttribute("aria-label")); }
    expect(order).toEqual(["Close", "See all changes", "Continue", "Close"]);
    await key("Tab", true);
    expect(document.activeElement).toBe(button("Continue"));
  });

  it("gives focus back to the opener when it goes", async () => {
    await show();
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it("Continue ends it with continue", async () => {
    await show(); await click("Continue");
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith("continue");
  });

  it("the X, Escape and the scrim end it with close", async () => {
    await show(); await click("Close");
    expect(props.onDone).toHaveBeenLastCalledWith("close");
    const escape = await key("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(props.onDone).toHaveBeenCalledTimes(2);
    const scrim = host.querySelector<HTMLElement>(".ui-scrim")!;
    await act(async () => { dialog().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(props.onDone, "a press inside the dialog").toHaveBeenCalledTimes(2);
    await act(async () => { scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(props.onDone).toHaveBeenCalledTimes(3);
    expect(props.onDone).toHaveBeenLastCalledWith("close");
  });

  it("See all changes opens the version's tag page and keeps the popup open", async () => {
    await show(); await click("See all changes");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(releaseNotesUrl("0.1.180"));
    expect(openExternal.mock.calls[0]![0]).toMatch(/\/releases\/tag\/v0\.1\.180$/);
    expect(props.onAllChanges).toHaveBeenCalledTimes(1);
    expect(props.onDone).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });
});
