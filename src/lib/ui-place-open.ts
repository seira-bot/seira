// What the place card in chat (app_settings show_place) does for an id of the UI map. The card shows only places of this
// fixed list; the person clicks the button, and the app never clicks the control it points at.
import { UI_PLACES, type UiPlace } from "../../shared/ui-places";
import type { Action } from "@/state/store";

const PLACES: readonly UiPlace[] = UI_PLACES;

/** The place with this exact id, or undefined for an id this client does not know (an older map). */
export function uiPlaceById(id: unknown): UiPlace | undefined {
  return typeof id === "string" ? PLACES.find((place) => place.id === id) : undefined;
}

/** How a client finds an element: the map's `data-ui` value, or the existing `data-tour` anchor the entry names. */
export interface PlaceAnchor {
  attr: "ui" | "tour";
  value: string;
}

/** The place card's request in the store: the host in App reads it, so the page change cannot unmount the spotlight. */
export interface PlaceLook { id: string; nonce: number; phase: "looking" | "spot" | "missing"; anchor?: PlaceAnchor }

export const anchorOf = (place: UiPlace): PlaceAnchor => (place.tour ? { attr: "tour", value: place.tour } : { attr: "ui", value: place.id });

/** The place, then its parents. A control inside a closed menu is reached through the control that opens the menu, so the
 * spotlight falls on that one and the card lists the clicks. */
export function placeChain(place: UiPlace): UiPlace[] {
  const chain: UiPlace[] = [];
  for (let one: UiPlace | undefined = place; one && !chain.includes(one); one = one.parent ? PLACES.find((other) => other.id === one!.parent) : undefined) chain.push(one);
  return chain;
}

/** The actions that open the page or panel a place sits in. Places in the sidebar need none. */
export function openActions(place: UiPlace): Action[] {
  const { id } = place;
  if (id.startsWith("automations.") || id.startsWith("workflow.")) {
    const view = id === "automations.calendar" ? "calendar" : id === "automations.list" ? "list" : id.startsWith("workflow.") || id === "automations.workflows" ? "workflows" : undefined;
    return [{ type: "showRoutines", ...(view ? { view } : {}) }];
  }
  if (id.startsWith("board.")) return [{ type: "showBoard" }];
  if (id.startsWith("files.")) return [{ type: "showFiles" }];
  if (id.startsWith("apps.")) return [{ type: "togglePlugins", open: true, ...(id.startsWith("apps.mcp") ? { surface: "mcp" as const } : {}) }];
  if (id.startsWith("panel.")) return [{ type: "toggleSettings", open: true }];
  if (id.startsWith("chat.") || id.startsWith("composer.") || id.startsWith("message.")) return [{ type: "showChat" }];
  return [];
}

/** What the card offers: a button, or only the clicks as text (a place that this mode does not show). */
export type PlaceMode = { button: true } | { button: false; why: "advanced" };

export function placeMode(place: UiPlace, advanced: boolean): PlaceMode {
  return place.advanced && !advanced ? { button: false, why: "advanced" } : { button: true };
}

/** The clicks as this mode shows them. */
export function placeSteps(place: UiPlace, advanced: boolean): readonly string[] {
  if (place.advanced && !advanced) return place.simplePath ? [place.simplePath] : place.steps;
  return advanced && place.advancedSteps ? place.advancedSteps : place.steps;
}

const visible = (el: Element) => el.getClientRects().length > 0;

/** Ids come from the fixed map, so they hold no quote that could break the selector. */
function query(anchor: PlaceAnchor, root: ParentNode): HTMLElement | null {
  const found = Array.from(root.querySelectorAll<HTMLElement>(`[data-${anchor.attr}="${anchor.value}"]`)).filter(visible);
  return found.at(-1) ?? null;
}

/** The first of the place and its parents that is on the screen now, or null. */
export function findPlaceAnchor(place: UiPlace, root: ParentNode = document): PlaceAnchor | null {
  for (const one of placeChain(place)) {
    const anchor = anchorOf(one);
    if (query(anchor, root)) return anchor;
  }
  return null;
}
