import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveConnectionPage, reusableConnectionUrl } from "./connector-oauth";

afterEach(() => vi.unstubAllGlobals());

describe("OAuth tab reservation", () => {
  it("reuses a link only before its original ten-minute expiry", () => {
    const page = { url: "https://auth.example.test/flow", createdAt: 1_000 };
    expect(reusableConnectionUrl(page, 1_000)).toBe(page.url);
    expect(reusableConnectionUrl(page, 600_999)).toBe(page.url);
    expect(reusableConnectionUrl(page, 601_000)).toBeNull();
    expect(reusableConnectionUrl(page, 601_001)).toBeNull();
    expect(reusableConnectionUrl(page, 999)).toBeNull();
    expect(reusableConnectionUrl(undefined)).toBeNull();
  });
  it("reserves synchronously, severs the opener and keeps a navigated tab open", async () => {
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => page);
    vi.stubGlobal("window", { open });
    const launch = reserveConnectionPage();
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(page.opener).toBeNull();
    expect(launch.confirms).toBe(true);
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(await launch.open("https://auth.example.test/flow")).toBe(true);
    expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/flow");
    launch.cancel();
    expect(page.close).not.toHaveBeenCalled();
  });

  it("detects blocked and manually closed tabs without retrying an asynchronous popup", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    const blocked = reserveConnectionPage();
    expect(await blocked.open("https://auth.example.test/flow")).toBe(false);
    expect(open).toHaveBeenCalledOnce();
    const page = { opener: {}, closed: true, location: { replace: vi.fn() }, close: vi.fn() };
    open.mockReturnValue(page as never);
    const closed = reserveConnectionPage();
    expect(await closed.open("https://auth.example.test/flow")).toBe(false);
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("closes only its own blank on cancellation and refuses late navigation", async () => {
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const launch = reserveConnectionPage();
    launch.cancel();
    expect(page.close).toHaveBeenCalledOnce();
    expect(await launch.open("https://auth.example.test/flow")).toBe(false);
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("keeps Electron external opening without reserving a browser tab", async () => {
    const openExternal = vi.fn(async () => {});
    const open = vi.fn();
    vi.stubGlobal("window", { ogb: { openExternal }, open });
    const launch = reserveConnectionPage();
    expect(open).not.toHaveBeenCalled();
    expect(launch.confirms).toBe(true);
    expect(await launch.open("https://auth.example.test/flow")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/flow");
  });

  it("opens straight to the page from a remote server's page in the desktop app, which has no openExternal", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { ogb: { platform: "darwin" }, open });
    const launch = reserveConnectionPage();
    expect(open).not.toHaveBeenCalled();
    expect(launch.confirms).toBe(false);
    expect(await launch.open("https://auth.example.test/flow")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://auth.example.test/flow", "_blank", "noopener,noreferrer");
  });

  it("says the page did not open when a remote server's page cannot hand it to the desktop app", async () => {
    vi.stubGlobal("window", { ogb: { platform: "win32" }, open: vi.fn(() => { throw new Error("refused"); }) });
    expect(await reserveConnectionPage().open("https://auth.example.test/flow")).toBe(false);
  });

  it("opens the page through the app's sign-in bridge from a remote server's page, and knows it opened", async () => {
    const openSignInPage = vi.fn(async () => true);
    const open = vi.fn();
    vi.stubGlobal("window", { ogb: { platform: "linux", openSignInPage }, open });
    const launch = reserveConnectionPage();
    expect(launch.confirms).toBe(true);
    expect(await launch.open("https://auth.example.test/flow")).toBe(true);
    expect(openSignInPage).toHaveBeenCalledWith("https://auth.example.test/flow");
    expect(open).not.toHaveBeenCalled();
  });

  it("says the page did not open when the app's sign-in bridge refuses it", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { ogb: { openSignInPage: vi.fn(async () => { throw new Error("Use the link to open the page."); }) }, open });
    expect(await reserveConnectionPage().open("https://auth.example.test/flow")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("says the page did not open when the desktop app refuses it", async () => {
    vi.stubGlobal("window", { ogb: { openExternal: vi.fn(async () => { throw new Error("only available while using the local server"); }) }, open: vi.fn() });
    expect(await reserveConnectionPage().open("https://auth.example.test/flow")).toBe(false);
  });

  it("opens the clean window only when asked and available, else the old path", async () => {
    const openExternal = vi.fn(async () => true);
    const openCleanSignInPage = vi.fn(async () => true);
    vi.stubGlobal("window", { ogb: { openExternal, openCleanSignInPage } });
    const url = "https://auth.example.test/flow";
    await reserveConnectionPage().open(url);
    await reserveConnectionPage().open(url, { cleanWindow: false });
    expect(openCleanSignInPage).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(2);
    await reserveConnectionPage().open(url, { cleanWindow: true });
    expect(openCleanSignInPage).toHaveBeenCalledWith(url);
    expect(openExternal).toHaveBeenCalledTimes(2);
    vi.stubGlobal("window", { ogb: { openExternal } });
    await reserveConnectionPage().open(url, { cleanWindow: true });
    expect(openExternal).toHaveBeenCalledTimes(3);
  });
});
