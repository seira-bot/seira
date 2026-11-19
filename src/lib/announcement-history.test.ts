import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { api } from "@/state/store";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { GROK_MOVE_NOTICE, TEAMS_NOTICE } from "@/lib/notices";
import { announcementHistory, announcementsReadAt, announcementsUnread, markAnnouncementsRead, READ_BASELINE, readMark, rememberNoticeSeen,
  type PersonRecord } from "./announcement-history";
import { announcementsReadAt as readMarkOf, newestReadMarkOnly, personalHints, teamPersonalHint } from "../../shared/cloud-hints";
import type { AnnouncementCard } from "../../shared/announcements";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const card = (id: string, extra: Partial<AnnouncementCard> = {}): AnnouncementCard => ({ id, kind: "product", title: `Card ${id}`, body: "Words",
  primary: { label: "Open", action: { open_url: "https://example.com" } }, ends: "2027-01-01T00:00:00Z", ...extra } as AnnouncementCard);
const ids = (cards: AnnouncementCard[] = [], feedUpdatedAt: number | null = null) =>
  announcementHistory({ cards, feedUpdatedAt, now: NOW }).map(item => item.id);

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.mocked(api).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("the announcements list", () => {
  it("is empty while the file has no card, and raises no dot", () => {
    expect(ids()).toEqual([]);
    expect(announcementsUnread(announcementHistory({ cards: [], feedUpdatedAt: null, now: NOW }), { record: record(), desktopSeen: [] })).toBe(false);
  });

  it("puts a card by its starts, else by when the file changed, newest first", () => {
    const cards = [card("old", { starts: "2026-10-20T00:00:00Z" }), card("later", { starts: "2026-11-20T00:00:00Z" }), card("undated")];
    expect(ids(cards, Date.parse("2026-11-12T00:00:00Z"))).toEqual(["later", "undated", "old"]);
  });

  it("keeps the file's order for cards of the same date", () => {
    expect(ids([card("first"), card("second")], Date.parse("2026-11-12T00:00:00Z"))).toEqual(["first", "second"]);
  });
});

describe("the red dot", () => {
  const items = (cards: AnnouncementCard[] = []) => announcementHistory({ cards, feedUpdatedAt: null, now: NOW });
  const person = (hints: string[] = [], desktopSeen: string[] = []): PersonRecord => ({ record: record(hints), desktopSeen });

  it("first run: a card dated before the baseline counts as read, a newer one raises the dot", () => {
    expect(READ_BASELINE).toBe(Date.parse("2026-11-11"));
    expect(announcementsReadAt(person())).toBe(READ_BASELINE);
    expect(announcementsUnread(items([card("old", { starts: "2026-11-01T00:00:00Z" })]), person())).toBe(false);
    expect(announcementsUnread(items([card("new", { starts: "2026-11-15T00:00:00Z" })]), person())).toBe(true);
  });

  it("goes once they saw the card, wherever it was recorded", () => {
    const cards = [card("phone-app", { starts: "2026-11-15T00:00:00Z" })];
    expect(announcementsUnread(items(cards), person(["announcement:phone-app"]))).toBe(false);
    expect(announcementsUnread(items(cards), person([], ["announcement:phone-app"])), "this desktop's record").toBe(false);
    storage.set("announcement:phone-app", "1");
    expect(announcementsUnread(items(cards), person()), "this browser").toBe(false);
  });

  it("comes back for something newer than their last look that they have not seen", () => {
    const later = card("phone-app", { starts: "2026-11-25T00:00:00Z" });
    const read = person([readMark(Date.parse("2026-11-20T00:00:00Z"))]);
    expect(announcementsUnread(items(), read)).toBe(false);
    expect(announcementsUnread(items([later]), read)).toBe(true);
    expect(announcementsUnread(items([later]), person([readMark(Date.parse("2026-11-20T00:00:00Z")), "announcement:phone-app"])), "a card they closed").toBe(false);
  });

  it("the newest of the browser's, the desktop's and the place's record counts", () => {
    storage.set("omb.announcements.read-at", String(Date.parse("2026-11-19T00:00:00Z")));
    expect(announcementsReadAt(person([readMark(Date.parse("2026-11-18T00:00:00Z"))], [readMark(Date.parse("2026-11-21T00:00:00Z"))]))).toBe(Date.parse("2026-11-21T00:00:00Z"));
    expect(announcementsReadAt(person([readMark(Date.parse("2026-11-22T00:00:00Z"))]))).toBe(Date.parse("2026-11-22T00:00:00Z"));
  });
});

describe("opening Announcements and seeing a popup", () => {
  const desktop = { seen: vi.fn(async () => {}) };
  beforeEach(() => desktop.seen.mockClear());

  it("on a page of one's own: the place's record keeps one read mark, the newest, beside its other hints, and the desktop's record keeps it too", async () => {
    vi.mocked(api).mockResolvedValue({ saved: true });
    const saved = vi.fn();
    markAnnouncementsRead(NOW, record(["tour-finished", readMark(1)]), { team: false, desktop, saved });
    await Promise.resolve(); await Promise.resolve();
    expect(storage.get("omb.announcements.read-at")).toBe(String(NOW));
    expect(desktop.seen).toHaveBeenCalledWith(readMark(NOW));
    expect(vi.mocked(api).mock.calls).toEqual([["/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: ["tour-finished", readMark(NOW)] } }) }]]);
    expect(saved).toHaveBeenCalledWith({ saved: true });
    expect(announcementsReadAt({ record: undefined, desktopSeen: [] })).toBe(NOW);
  });

  it("on a Team Cloud: the person's own record, which members may write too, then the place's record read back", async () => {
    vi.mocked(api).mockImplementation(async path => (path === "/api/config" ? { onboarding: { hintsSeen: [readMark(NOW)] } } : { welcome: {} }));
    const saved = vi.fn();
    markAnnouncementsRead(NOW, record(["teams-2026-11"]), { team: true, saved });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(vi.mocked(api).mock.calls).toEqual([["/api/me/welcome", { method: "PUT", body: JSON.stringify({ hints: [readMark(NOW)] }) }], ["/api/config"]]);
    expect(saved).toHaveBeenCalledWith({ onboarding: { hintsSeen: [readMark(NOW)] } });
    vi.mocked(api).mockClear();
    rememberNoticeSeen(TEAMS_NOTICE, record(), { team: true, desktop, saved });
    expect(vi.mocked(api).mock.calls[0]).toEqual(["/api/me/welcome", { method: "PUT", body: JSON.stringify({ hints: [TEAMS_NOTICE] }) }]);
    expect(storage.get(TEAMS_NOTICE)).toBe("1");
    expect(desktop.seen).toHaveBeenCalledWith(TEAMS_NOTICE);
  });

  it("a failed save leaves the browser's record, and nothing throws", async () => {
    vi.mocked(api).mockRejectedValue(new Error("offline"));
    expect(() => markAnnouncementsRead(NOW, record(), { team: false, saved: vi.fn() })).not.toThrow();
    await Promise.resolve();
    expect(storage.get("omb.announcements.read-at")).toBe(String(NOW));
  });
});

describe("a Team Cloud's personal record", () => {
  it("keeps the Teams popup and the read mark each person's own, the newest read mark only", () => {
    expect(teamPersonalHint(TEAMS_NOTICE)).toBe(true);
    expect(teamPersonalHint(readMark(NOW))).toBe(true);
    expect(teamPersonalHint("announcements-read-x")).toBe(false);
    expect(teamPersonalHint(GROK_MOVE_NOTICE), "other notices stay the team's").toBe(false);
    expect(newestReadMarkOnly(["a", readMark(5), readMark(9), "b", readMark(7)])).toEqual(["a", readMark(9), "b"]);
    expect(readMarkOf(["a"])).toBeNull();
    const own = [TEAMS_NOTICE, readMark(9)], team = ["tour-finished", TEAMS_NOTICE, readMark(3)];
    expect(personalHints(team, own, false), "a member reads the team's steps and their own marks").toEqual(["tour-finished", TEAMS_NOTICE, readMark(9)]);
    expect(personalHints(team, [], false), "nobody else's").toEqual(["tour-finished"]);
  });
});
