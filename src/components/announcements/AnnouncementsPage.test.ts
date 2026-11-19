// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcementHistory } from "@/lib/announcement-history";
import { setLocale } from "@/lib/i18n";
import type { AnnouncementCard } from "../../../shared/announcements";
import type { Announcements } from "./use-announcements";

const f = vi.hoisted(() => ({ found: null as unknown as Announcements, dispatch: vi.fn(), state: { config: {} as Record<string, unknown> } }));
vi.mock("./use-announcements", () => ({ useAnnouncements: () => f.found }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn() }));
const { AnnouncementsPage } = await import("./AnnouncementsPage");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse("2026-11-18T10:00:00Z");
const card: AnnouncementCard = { id: "phone-app-2026-11", kind: "product", title: { en: "Seira on your phone", "pt-br": "Seira no seu celular" }, body: "Chat with your bots anywhere.",
  primary: { label: "Open", action: { open: "my_cloud" } }, starts: "2026-11-20T00:00:00Z", ends: "2027-01-01T00:00:00Z" } as AnnouncementCard;
const markRead = vi.fn();
const found = (cards: AnnouncementCard[], extra: Partial<Announcements> = {}): Announcements => ({
  items: announcementHistory({ cards, feedUpdatedAt: null, now: NOW }), unread: false, markRead,
  person: { record: undefined, desktopSeen: [] }, writer: { team: false, saved: vi.fn() }, ...extra,
});

let host: HTMLDivElement, root: Root | null = null;
async function open() {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(AnnouncementsPage)); });
  await act(async () => { await Promise.resolve(); });
}
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-announcement-item]")];
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); };

beforeEach(() => {
  setLocale("en"); vi.clearAllMocks(); f.state = { config: {} };
  host = document.createElement("div"); document.body.append(host);
  vi.stubGlobal("open", vi.fn());
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); vi.unstubAllGlobals(); });

describe("Announcements", () => {
  it("lists only the cards from the feed, newest first, each with its date, words and buttons", async () => {
    const earlier = { ...card, id: "earlier-card", title: "Earlier", starts: "2026-11-12T00:00:00Z", secondary: { label: "Visit", action: { open_url: "https://example.com/more" } } } as AnnouncementCard;
    f.found = found([earlier, card]);
    await open();
    expect(document.querySelector("h1")?.textContent).toBe("Announcements");
    expect(rows().map(row => row.dataset.announcementItem)).toEqual([card.id, "earlier-card"]);
    const first = rows()[0]!;
    expect(first.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-20T00:00:00.000Z");
    expect(first.textContent).toContain("Nov 20, 2026");
    expect(first.textContent).toContain("Seira on your phone");
    expect([...rows()[1]!.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Open", "Visit"]);
  });

  it("with no card in the feed, shows the empty state and clears nothing", async () => {
    f.found = found([]);
    await open();
    expect(rows()).toEqual([]);
    expect(document.body.textContent).toContain("Nothing has been announced here yet.");
    expect(markRead).not.toHaveBeenCalled();
  });

  it("each button does what its card says", async () => {
    f.found = found([{ ...card, secondary: { label: "Visit", action: { open_url: "https://example.com/more" } } } as AnnouncementCard]);
    await open();
    const buttons = [...rows()[0]!.querySelectorAll("button")];
    await click(buttons.find(button => button.textContent === "Open"));
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
    await click(buttons.find(button => button.textContent === "Visit"));
    expect(window.open).toHaveBeenCalledWith("https://example.com/more", "_blank", "noopener,noreferrer");
  });

  it("opening it clears the red dot; with no dot there is nothing to write", async () => {
    f.found = found([card]);
    await open();
    expect(markRead).not.toHaveBeenCalled();
    await act(async () => root?.unmount()); root = null;
    f.found = found([card], { unread: true });
    await open();
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("shows a card's words in the person's language", async () => {
    setLocale("pt-br");
    f.found = found([card]);
    await open();
    expect(rows()[0]!.textContent).toContain("Seira no seu celular");
    expect(document.querySelector("h1")?.textContent).toBe("Anúncios");
  });
});
