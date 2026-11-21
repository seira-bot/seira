import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api }));

import { fetchAppUsage } from "./app-usage";

beforeEach(() => { store.api.mockReset(); });

describe("fetchAppUsage", () => {
  it("asks for the last week and returns the apps", async () => {
    store.api.mockResolvedValue({ since: 1, apps: [{ app: "GMAIL", calls: 3 }] });
    expect(await fetchAppUsage()).toEqual([{ app: "GMAIL", calls: 3 }]);
    expect(store.api).toHaveBeenCalledWith("/api/apps/usage");
  });
  it("returns nothing when the request fails", async () => {
    store.api.mockRejectedValue(new Error("offline"));
    expect(await fetchAppUsage()).toEqual([]);
  });
  it("returns nothing for an answer of the wrong shape and drops a bad entry", async () => {
    store.api.mockResolvedValue({ apps: "none" });
    expect(await fetchAppUsage()).toEqual([]);
    store.api.mockResolvedValue({ apps: [{ app: "GMAIL" }, { app: "SLACK", calls: 1 }] });
    expect(await fetchAppUsage()).toEqual([{ app: "SLACK", calls: 1 }]);
  });
});
