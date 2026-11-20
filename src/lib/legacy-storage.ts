import { currentStorageKey } from "../../electron/legacy-names.mjs";

type Keyed = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** Copies each value an earlier version saved under its old key to the current key when that is still unset, then
 * removes the old key. A value already under the current key is kept. Safe to run on every start. */
export function migrateLegacyStorage(storage: Keyed): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    const current = currentStorageKey(key);
    if (current === null) continue;
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(current) === null) storage.setItem(current, value);
    storage.removeItem(key);
  }
}

/** The key as a backup written by an earlier version names it, mapped to the current name. Current names pass through. */
export function currentClientStateKeys(values: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const current = currentStorageKey(key);
    if (current !== null && !Object.hasOwn(values, current)) mapped[current] = value;
    else if (current === null) mapped[key] = value;
  }
  return mapped;
}

try {
  if (typeof localStorage !== "undefined") migrateLegacyStorage(localStorage);
} catch { /* storage can be blocked */ }
