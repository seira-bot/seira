import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/analytics", () => ({ usageAnalyticsChoice: () => f.on }));
vi.mock("@/state/store", () => ({ api: vi.fn().mockResolvedValue({}) }));

let storage: Map<string, string>;
async function load() {
  vi.resetModules();
  const { api } = await import("@/state/store");
  const counts = await import("./announcement-counts");
  return { api: vi.mocked(api), ...counts };
}

beforeEach(() => {
  f.on = true;
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("announcement counts on the page", () => {
  it("AC-01 posts the card id and action once for each card and action", async () => {
    const { api, countAnnouncement } = await load();
    countAnnouncement({ id: "card-one" }, "shown");
    countAnnouncement({ id: "card-one" }, "shown");
    countAnnouncement({ id: "card-one" }, "primary");
    countAnnouncement({ id: "card-two" }, "shown");
    expect(api.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      ["/api/announcements/events", "POST", JSON.stringify({ id: "card-one", action: "shown" })],
      ["/api/announcements/events", "POST", JSON.stringify({ id: "card-one", action: "primary" })],
      ["/api/announcements/events", "POST", JSON.stringify({ id: "card-two", action: "shown" })],
    ]);
  });

  it("AC-03 sends no count while Usage analytics is off", async () => {
    f.on = false;
    const { api, countAnnouncement } = await load();
    countAnnouncement({ id: "card-one" }, "shown");
    expect(api).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it("AC-04 does not send a counted card again after reload", async () => {
    const first = await load();
    first.countAnnouncement({ id: "card-one" }, "shown");
    expect(first.api).toHaveBeenCalledTimes(1);
    const reloaded = await load();
    reloaded.countAnnouncement({ id: "card-one" }, "shown");
    expect(reloaded.api).not.toHaveBeenCalled();
    reloaded.countAnnouncement({ id: "card-one" }, "close");
    expect(reloaded.api).toHaveBeenCalledTimes(1);
  });

  it("AC-04 keeps at most 200 card ids and drops the oldest", async () => {
    const { countAnnouncement, MAX_COUNTED_CARDS } = await load();
    for (let i = 0; i < MAX_COUNTED_CARDS + 5; i += 1) countAnnouncement({ id: `card-${i}` }, "shown");
    const kept = JSON.parse(storage.get("seira.announcement.counted")!) as Array<[string, string[]]>;
    expect(kept).toHaveLength(MAX_COUNTED_CARDS);
    expect(kept[0]![0]).toBe("card-5");
  });

  it("AC-08 shows no error when the post fails or storage is unavailable", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    const { api, countAnnouncement } = await load();
    api.mockRejectedValueOnce(new Error("offline"));
    expect(() => countAnnouncement({ id: "card-one" }, "shown")).not.toThrow();
    await Promise.resolve();
  });
});
