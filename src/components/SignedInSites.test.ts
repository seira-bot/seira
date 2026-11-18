// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), queue: [] as Array<() => Promise<unknown>>, profiles: null as null | (() => Promise<unknown>) }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));
const { ApiError } = await import("@/state/api");
const { SignedInSites } = await import("./SignedInSites");

const PROFILES = "/api/browser-sites/import/profiles";
const answer = (value: unknown) => { fixture.queue.push(() => Promise.resolve(value)); };
const fail = (error: Error) => { fixture.queue.push(() => Promise.reject(error)); };
const calls = () => fixture.api.mock.calls.filter(([path]) => path !== PROFILES);
const offered = (profiles: unknown[]) => { fixture.profiles = () => Promise.resolve({ profiles }); };
const chrome = { id: "chrome-default", name: "Default", browserName: "Google Chrome", lastUsed: true };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const google = { site: "google.com", cookies: 4, storage: 1 };
const example = { site: "example.com", cookies: 1, storage: 0 };

beforeEach(() => {
  fixture.api.mockReset();
  fixture.queue = [];
  fixture.profiles = () => Promise.reject(new ApiError("Not found", 404));
  fixture.api.mockImplementation((path: string) => (path === PROFILES ? fixture.profiles!() : fixture.queue.shift()!()));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(props: Parameters<typeof SignedInSites>[0]) {
  await act(async () => root.render(createElement(SignedInSites, props)));
}
// Opening a <details> fires its toggle event, as in a browser.
async function open() {
  await act(async () => { host.querySelector("details")!.open = true; });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;
async function click(label: string) {
  await act(async () => button(label).click());
}
const listed = () => [...host.querySelectorAll("li span")].map((span) => span.textContent);

describe("signed-in sites", () => {
  it("loads only when opened, then lists each site", async () => {
    answer({ running: false, sites: [example, google] });
    await render({ target: { profile: "profile-work" }, sharedBy: ["Pepper"] });
    expect(calls()).toHaveLength(0);
    await open();
    expect(fixture.api).toHaveBeenCalledWith("/api/browser-sites?profile=profile-work");
    expect(listed()).toEqual(["example.com", "google.com"]);
    expect(host.textContent).not.toContain("share this browser");
  });

  it("bare, it has no fold or title and loads as soon as it is shown", async () => {
    answer({ running: true, sites: [example, google] }); answer({ running: true, sites: [google] });
    await render({ bare: true, target: { bot: "pepper" }, sharedBy: ["Pepper"] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls()).toHaveLength(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/browser-sites?bot=pepper");
    expect(host.querySelector("details")).toBeNull();
    expect(host.textContent).not.toContain("Signed-in sites");
    expect(listed()).toEqual(["example.com", "google.com"]);
    await click("Sign out of example.com");
    expect(calls()).toHaveLength(2);
    expect(listed()).toEqual(["google.com"]);
  });

  it("signs out of one site, and shows what is left", async () => {
    answer({ running: true, sites: [example, google] }); answer({ running: true, sites: [example] });
    await render({ target: { bot: "pepper" }, sharedBy: ["Pepper"] });
    await open();
    await click("Sign out of google.com");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/sign-out", { method: "POST", body: JSON.stringify({ bot: "pepper", site: "google.com" }) });
    expect(listed()).toEqual(["example.com"]);
  });

  it("on a Team Cloud, reads and signs out of the browser of the conversation shown", async () => {
    answer({ running: true, sites: [example] }); answer({ running: true, sites: [] });
    await render({ bare: true, target: { bot: "pepper" }, scope: { threadId: "ada-chat" }, sharedBy: ["Pepper"] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenCalledWith("/api/browser-sites?bot=pepper&threadId=ada-chat");
    await click("Sign out of example.com");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/sign-out", { method: "POST", body: JSON.stringify({ bot: "pepper", threadId: "ada-chat", site: "example.com" }) });
  });

  it("signs out of all, and says when nothing is left", async () => {
    answer({ running: false, sites: [example, google] }); answer({ running: false, sites: [] });
    await render({ target: { profile: "profile-work" }, sharedBy: ["Pepper", "Scout"] });
    await open();
    expect(host.textContent).toContain("Pepper, Scout share this browser: signing out here signs all of them out.");
    await click("Sign out of all");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/sign-out", { method: "POST", body: JSON.stringify({ profile: "profile-work" }) });
    expect(host.textContent).toContain("Not signed in to any site.");
    expect(host.querySelector("button")).toBeNull();
  });

  it("shows the server's reason when it cannot read the browser, and keeps buttons off while disabled", async () => {
    fail(new Error("The browser did not answer. Try again when the bot has finished."));
    await render({ target: { profile: "profile-work" }, sharedBy: [] });
    await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("The browser did not answer. Try again when the bot has finished.");
    answer({ running: false, sites: [google] });
    await render({ target: { profile: "profile-other" }, sharedBy: [], disabled: true });
    await act(async () => { host.querySelector("details")!.open = false; });
    await open();
    expect(button("Sign out of google.com").disabled).toBe(true);
    expect(button("Sign out of all").disabled).toBe(true);
  });

  it("offers no import control when the profile list is refused, empty, or the answer is odd", async () => {
    for (const answerFor of [() => Promise.reject(new ApiError("Not found", 404)), () => Promise.reject(new ApiError("Forbidden", 403)), () => Promise.resolve({ profiles: [] }), () => Promise.resolve({})]) {
      fixture.profiles = answerFor;
      answer({ running: false, sites: [google] });
      await render({ bare: true, target: { bot: "pepper" }, sharedBy: [] });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain("google.com");
      expect(host.textContent).not.toContain("Import from Chrome");
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it("asks for the profiles once, and shows the import control when they come", async () => {
    offered([chrome]);
    answer({ running: false, sites: [google] });
    await render({ bare: true, target: { bot: "pepper" }, sharedBy: [] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api.mock.calls.filter(([path]) => path === PROFILES)).toHaveLength(1);
    expect(button("Import from Chrome").disabled).toBe(false);
  });

  it("keeps the import control off while disabled, and says why", async () => {
    offered([chrome]);
    answer({ running: false, sites: [] });
    await render({ bare: true, target: { bot: "pepper" }, sharedBy: [], disabled: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const control = button("Import from Chrome");
    expect(control.disabled).toBe(true);
    expect(control.title).toBe("Try again when the bot has finished.");
  });

  it("replaces the list with the sites the import answers with", async () => {
    offered([chrome]);
    answer({ running: false, sites: [example] });
    await render({ bare: true, target: { bot: "pepper" }, sharedBy: [] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(listed()).toEqual(["example.com"]);
    await click("Import from Chrome");
    answer({ ticket: "t1", profileName: "Default", browserName: "Google Chrome", sites: [{ site: "google.com", cookies: 4, sensitive: null, suggested: true }] });
    answer({ imported: { sites: 1, cookies: 4 }, skipped: 0, running: false, sites: [example, google] });
    const inDialog = (label: string) => act(async () => [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!.click());
    await inDialog("Continue");
    await inDialog("Import 1 site");
    expect(document.body.textContent).toContain("Imported 1 site (4 cookies).");
    await inDialog("Close");
    expect(listed().filter((text) => text === "example.com" || text === "google.com").sort()).toEqual(["example.com", "google.com"]);
  });
});
