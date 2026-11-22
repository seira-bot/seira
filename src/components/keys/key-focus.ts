import { useSyncExternalStore } from "react";
import type { Action, AppSettingsSection } from "@/state/store";
import { keyEntry, keySection, type KeyId } from "./key-catalog";

/** A named open of the keys page: `row` is where it lands, the key's own row or a row in another section that uses it.
 * Every request is a new object, so following the same link again lands there again. */
export interface KeyFocusRequest { id?: KeyId; row?: KeyId; nonce: number }

const OPEN_KEYS = { type: "toggleAppSettings", open: true, section: "connections" } as const satisfies Action;

let latest: KeyFocusRequest | null = null;
let nonce = 0;
const watchers = new Set<() => void>();

function publish(next: KeyFocusRequest | null) {
  latest = next;
  for (const watch of Array.from(watchers)) watch();
}

/** The action that opens Settings on the keys page, at the row for `id` (or, with `purpose`, the row of that name that
 * uses the key): its section opens, the row scrolls into view, its field takes focus and the row lights up briefly.
 * With no key it opens the page at its first section. A key whose field is on another part of Settings (Routing, Images)
 * opens that part instead. */
export function openKeySettings(id?: KeyId, purpose?: KeyId): typeof OPEN_KEYS | { type: "toggleAppSettings"; open: true; section: AppSettingsSection } {
  const owner = id ? keySection(keyEntry(id)).opens : undefined;
  if (owner) return { type: "toggleAppSettings", open: true, section: owner };
  nonce += 1;
  publish(id ? { id, row: purpose ?? id, nonce } : { nonce });
  return OPEN_KEYS;
}

export function finishKeyFocus(request: KeyFocusRequest) {
  if (latest?.nonce === request.nonce) publish(null);
}

function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => { watchers.delete(watch); };
}

const snapshot = () => latest;

export function useKeyFocus(): KeyFocusRequest | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
