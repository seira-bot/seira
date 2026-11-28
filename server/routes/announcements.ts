import { announcementCounter, parseCountEvent } from "../announcements/counts.ts";
import { announcementCardsForPage, announcementsUpdatedAt, announcementStore } from "../announcements/feed.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const ANNOUNCEMENTS_PATH = "/api/announcements";
export const ANNOUNCEMENT_EVENTS_PATH = "/api/announcements/events";
const EVENT_BODY_BYTES = 1024;

/** GET /api/announcements: the announcement cards whose time has not passed, from the project's file and from
 * Seira's own team feed, and when the newer of the two last changed (`updatedAt`, the date Announcements gives a card
 * without `starts`), for every signed-in page alike (request-auth.ts lets
 * a Team Cloud's members read it). Each page decides for itself which card, if any, it shows. Asking refreshes this
 * server's copies when they are an hour old; it never fails for want of the network. */
export const announcementRoutes: RouteHandler = async (ctx) => {
  const { res, path, method, json } = ctx;
  if (path === ANNOUNCEMENT_EVENTS_PATH) return countRoute(ctx);
  if (path !== ANNOUNCEMENTS_PATH) return PASS;
  if (method !== "GET") return json(res, 405, { error: "Use GET." });
  const cards = await announcementCardsForPage();
  return json(res, 200, announcementStore().disabled ? { cards, disabled: true } : { cards, updatedAt: announcementsUpdatedAt() });
};

/** POST /api/announcements/events: one card step to count, `{ id, action }`. A card this server does not serve is dropped
 * and still answered 204; a wrong shape is a 400. The server batches the counts for Seira Cloud (announcements/counts.ts). */
async function countRoute({ req, res, method, json, readBody }: RouteContext): Promise<void> {
  if (method !== "POST") return json(res, 405, { error: "Use POST." });
  const event = parseCountEvent(await readBody(req, EVENT_BODY_BYTES));
  if (!event) return json(res, 400, { error: "Send { id, action }." });
  announcementCounter().record(event);
  res.writeHead(204).end();
}
