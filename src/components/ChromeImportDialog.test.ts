// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));
const { ApiError } = await import("@/state/api");
const { ChromeImportDialog } = await import("./ChromeImportDialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onImported = vi.fn();
const onClose = vi.fn();
const profiles = [
  { id: "p-work", name: "Work", browserName: "Chromium", lastUsed: false },
  { id: "p-main", name: "Main", browserName: "Google Chrome", lastUsed: true },
];
const found = {
  ticket: "t-1",
  profileName: "Main",
  browserName: "Google Chrome",
  sites: [
    { site: "shop.example", cookies: 3, sensitive: null, suggested: true },
    { site: "news.example", cookies: 1, sensitive: null, suggested: false },
    { site: "accounts.example", cookies: 2, sensitive: "identity", suggested: true },
    { site: "mail.example", cookies: 2, sensitive: "email", suggested: true },
    { site: "bank.example", cookies: 2, sensitive: "financial", suggested: true },
  ],
};
const target = { bot: "pepper" };

beforeEach(() => {
  fixture.api.mockReset();
  onImported.mockReset();
  onClose.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(props: Partial<Parameters<typeof ChromeImportDialog>[0]> = {}) {
  await act(async () => root.render(createElement(ChromeImportDialog, { profiles, target, sharedBy: ["Pepper"], onImported, onClose, ...props })));
}
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
const click = (label: string) => act(async () => button(label).click());
const checkboxes = () => [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const rowOf = (site: string) => checkboxes().find((box) => box.closest("label")?.textContent?.includes(site))!;
const selectAll = () => rowOf("Select all");
const siteRows = () => checkboxes().filter((box) => box !== selectAll());
const search = () => document.body.querySelector<HTMLInputElement>('input[type="search"]')!;
const typeSearch = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
  search().dispatchEvent(new Event("input", { bubbles: true }));
});
async function openList() {
  fixture.api.mockResolvedValueOnce(found);
  await open();
  await click("Continue");
}

describe("Chrome import dialog", () => {
  it("shows the consent text with the last used profile chosen, and asks for no sites yet", async () => {
    await open();
    expect(text()).toContain("will read which sites you are signed in to in Google Chrome. It copies nothing until you choose sites.");
    const radios = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.closest("label")?.textContent?.startsWith("Main"))).toEqual([true, false]);
    expect(radios[0]!.checked).toBe(true);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(text()).not.toContain("share this browser");
  });

  it("names every bot sharing the browser", async () => {
    await open({ sharedBy: ["Pepper", "Scout"] });
    expect(text()).toContain("Pepper, Scout share this browser");
  });

  it("moves focus in, cancels on Escape, and gives focus back to the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await open();
    expect(document.body.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(host);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("checks suggested sites, leaves sensitive ones unchecked and labelled", async () => {
    fixture.api.mockResolvedValueOnce(found);
    await open();
    await click("Continue");
    expect(fixture.api).toHaveBeenCalledWith("/api/browser-sites/import/sites", { method: "POST", body: JSON.stringify({ bot: "pepper", source: "p-main" }) });
    expect(rowOf("shop.example").checked).toBe(true);
    expect(rowOf("news.example").checked).toBe(false);
    for (const site of ["accounts.example", "mail.example", "bank.example"]) expect(rowOf(site).checked).toBe(false);
    expect(rowOf("accounts.example").closest("label")!.textContent).toContain("Sign-in service");
    expect(rowOf("mail.example").closest("label")!.textContent).toContain("Email");
    expect(rowOf("bank.example").closest("label")!.textContent).toContain("Money");
    expect(text()).toContain("Sensitive sites are not selected for you.");
    expect(button("Import 1 site")).toBeTruthy();
  });

  it("disables the import at zero with a reason", async () => {
    fixture.api.mockResolvedValueOnce(found);
    await open();
    await click("Continue");
    await act(async () => rowOf("shop.example").click());
    const importButton = button("Import 0 sites");
    expect(importButton.disabled).toBe(true);
    expect(text()).toContain("Choose at least one site to import.");
    expect(document.getElementById(importButton.getAttribute("aria-describedby")!)?.textContent).toBe("Choose at least one site to import.");
  });

  it("imports the chosen sites, then shows the counts and hands over the new list", async () => {
    fixture.api.mockResolvedValueOnce(found);
    const sites = [{ site: "shop.example", cookies: 3, storage: 0 }, { site: "bank.example", cookies: 2, storage: 0 }];
    fixture.api.mockResolvedValueOnce({ imported: { sites: 2, cookies: 5 }, skipped: 1, running: false, sites });
    await open({ scope: { threadId: "ada-chat" } });
    await click("Continue");
    await act(async () => rowOf("bank.example").click());
    await click("Import 2 sites");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/import", { method: "POST", body: JSON.stringify({ bot: "pepper", threadId: "ada-chat", ticket: "t-1", sites: ["shop.example", "bank.example"] }) });
    expect(text()).toContain("Imported 2 sites (5 cookies).");
    expect(text()).toContain("Skipped 1.");
    expect(onImported).toHaveBeenCalledWith(sites);
    await click("Close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves out the skipped line when nothing was skipped", async () => {
    fixture.api.mockResolvedValueOnce(found);
    fixture.api.mockResolvedValueOnce({ imported: { sites: 1, cookies: 3 }, skipped: 0, running: true, sites: [] });
    await open();
    await click("Continue");
    await click("Import 1 site");
    expect(text()).not.toContain("Skipped");
  });

  it("goes back to the profile step with the message when the list has expired", async () => {
    fixture.api.mockResolvedValueOnce(found);
    fixture.api.mockRejectedValueOnce(new ApiError("That list is out of date. Choose a profile again.", 409));
    await open();
    await click("Continue");
    await click("Import 1 site");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("That list is out of date. Choose a profile again.");
    expect(button("Continue")).toBeTruthy();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("shows the server's message when the import cannot be done, and stays on the list", async () => {
    fixture.api.mockResolvedValueOnce(found);
    fixture.api.mockRejectedValueOnce(new ApiError("Seira could not open Chrome's saved logins. Unlock your computer's password store, then try again.", 503));
    await open();
    await click("Continue");
    await click("Import 1 site");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Unlock your computer's password store");
    expect(button("Import 1 site")).toBeTruthy();
  });

  it("shows the server's message when the profile is too large or gone, and stays on the profile step", async () => {
    fixture.api.mockRejectedValueOnce(new ApiError("This Chrome profile is too large to import.", 413));
    await open();
    await click("Continue");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("This Chrome profile is too large to import.");
    expect(button("Continue")).toBeTruthy();
  });

  it("shows only the sites that match the search, ignoring case", async () => {
    await openList();
    expect(search().getAttribute("aria-label")).toBe("Search sites");
    await typeSearch("  SHOP ");
    expect(siteRows().map((box) => box.closest("label")!.textContent)).toEqual(["shop.example"]);
    await typeSearch("");
    expect(siteRows()).toHaveLength(found.sites.length);
  });

  it("checks and unchecks every shown site with Select all, sensitive ones included", async () => {
    await openList();
    await act(async () => selectAll().click());
    expect(siteRows().every((box) => box.checked)).toBe(true);
    expect(button("Import 5 sites")).toBeTruthy();
    await act(async () => selectAll().click());
    expect(siteRows().some((box) => box.checked)).toBe(false);
    expect(button("Import 0 sites").disabled).toBe(true);
  });

  it("marks Select all as partly checked while only some shown sites are checked", async () => {
    await openList();
    expect(selectAll().checked).toBe(false);
    expect(selectAll().indeterminate).toBe(true);
    await act(async () => selectAll().click());
    expect(selectAll().checked).toBe(true);
    expect(selectAll().indeterminate).toBe(false);
    await typeSearch("shop");
    expect(selectAll().checked).toBe(true);
    expect(selectAll().indeterminate).toBe(false);
  });

  it("says nothing matches and turns Select all off when the search finds no site", async () => {
    await openList();
    await typeSearch("nowhere");
    expect(text()).toContain("No sites match.");
    expect(siteRows()).toHaveLength(0);
    expect(selectAll().disabled).toBe(true);
  });

  it("imports checked sites that the search hides", async () => {
    await openList();
    fixture.api.mockResolvedValueOnce({ imported: { sites: 2, cookies: 5 }, skipped: 0, running: false, sites: [] });
    await typeSearch("bank");
    await act(async () => selectAll().click());
    expect(rowOf("shop.example")).toBeUndefined();
    await click("Import 2 sites");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/import", { method: "POST", body: JSON.stringify({ bot: "pepper", ticket: "t-1", sites: ["shop.example", "bank.example"] }) });
  });

  it("clears the search on Escape instead of closing", async () => {
    await openList();
    await typeSearch("bank");
    act(() => { search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(search().value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    act(() => { search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back from the list to the profiles", async () => {
    fixture.api.mockResolvedValueOnce(found);
    await open();
    await click("Continue");
    await click("Back");
    expect(button("Continue")).toBeTruthy();
  });

  it("uses no internal words in its text", async () => {
    fixture.api.mockResolvedValueOnce(found);
    await open();
    await click("Continue");
    expect(text()).not.toMatch(/ticket|endpoint|database|keyring|CDP|algorithm|cookie file/i);
  });
});
