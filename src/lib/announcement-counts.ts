// The anonymous card count: one { id, action } per card and step, once per device. It is separate from PostHog and has no
// key: the page posts to its own server, which batches the counts for Seira Cloud (server/announcements/counts.ts).
import { usageAnalyticsChoice } from "@/lib/analytics";
import { api } from "@/state/store";
import { ANNOUNCEMENT_COUNT_ACTIONS, type AnnouncementCountAction } from "../../shared/announcements";

const COUNTED_KEY = "seira.announcement.counted";
export const MAX_COUNTED_CARDS = 200;
const EVENTS_PATH = "/api/announcements/events";

type Counted = Array<[id: string, actions: AnnouncementCountAction[]]>;

const sentThisSession = new Set<string>();

function readCounted(): Counted {
  try {
    const raw = JSON.parse(localStorage.getItem(COUNTED_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): Counted => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) return [];
      return [[entry[0], entry[1].filter((action): action is AnnouncementCountAction => ANNOUNCEMENT_COUNT_ACTIONS.includes(action))]];
    });
  } catch {
    return [];
  }
}

/** True when this device has not counted the card and action yet; remembers it. */
function claim(id: string, action: AnnouncementCountAction): boolean {
  const key = `${id}\n${action}`;
  if (sentThisSession.has(key)) return false;
  sentThisSession.add(key);
  const counted = readCounted();
  const entry = counted.find(([known]) => known === id);
  if (entry?.[1].includes(action)) return false;
  if (entry) entry[1].push(action);
  else counted.push([id, [action]]);
  try {
    localStorage.setItem(COUNTED_KEY, JSON.stringify(counted.slice(-MAX_COUNTED_CARDS)));
  } catch {
    // The in-memory mark still holds for this page.
  }
  return true;
}

/** Counts a card's step once per device, unless the person turned Usage analytics off. Never throws and never shows an error. */
export function countAnnouncement(card: { id: string }, action: AnnouncementCountAction): void {
  try {
    if (!usageAnalyticsChoice() || !claim(card.id, action)) return;
    void api(EVENTS_PATH, { method: "POST", body: JSON.stringify({ id: card.id, action }), background: true }).catch(() => {});
  } catch {
    // A count never gets in the way of the card.
  }
}
