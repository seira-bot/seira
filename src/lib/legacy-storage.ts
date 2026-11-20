import { currentStateKeys, currentStorageKey } from "../../electron/legacy-names.mjs";

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

/** The values of a backup written by an earlier version, under the current key names. */
export const currentClientStateKeys = (values: Record<string, unknown>): Record<string, unknown> => currentStateKeys(values);

try {
  if (typeof localStorage !== "undefined") migrateLegacyStorage(localStorage);
} catch { /* storage can be blocked */ }
