import { describe, expect, it } from "vitest";

import { SETTINGS_PLACES } from "../../shared/settings-places.ts";
import { CONFIG_PATCH_FIELDS } from "../config.ts";
import { FIELD_ENTRIES, PLACE_EXCLUSIONS } from "./coverage.ts";
import { createSettingsRegistry, type RegistryDeps } from "./registry.ts";

const none = async () => null;
const deps: RegistryDeps = {
  cfg: () => ({}) as ReturnType<RegistryDeps["cfg"]>, saveConfig: none, bots: () => [], sections: () => [], reorderBots: none, groupBots: none, pinBot: none, patchBot: none,
  call: none, read: async () => null, paused: () => [], credentials: () => ({}), window: { read: () => undefined, write: () => null },
  engines: () => [], addEngine: none, removeEngine: none, threadModes: () => ({}), setThreadModes: none, threadModeRefusal: () => null,
};
const entries = createSettingsRegistry(deps);
const entryIds = new Set(entries.map((entry) => entry.id));
const placeIds = new Set<string>(SETTINGS_PLACES.map((place) => place.id));
const fieldNames = Object.keys(CONFIG_PATCH_FIELDS);
const REASON_MIN = 10;
const reasons: Array<[string, string]> = [
  ...Object.entries(FIELD_ENTRIES).flatMap(([field, row]): Array<[string, string]> => ("excluded" in row ? [[`field ${field}`, row.excluded]] : [])),
  ...Object.entries(PLACE_EXCLUSIONS).map(([place, reason]): [string, string] => [`place ${place}`, reason]),
];

describe("app settings coverage", () => {
  it("gives every config patch field an entry or a reason", () => {
    const missing = fieldNames.filter((field) => !(field in FIELD_ENTRIES));
    expect(missing, `Config field without an app_settings entry: ${missing.join(", ")}. Add it to FIELD_ENTRIES in server/app-settings/coverage.ts with the entry ids that write it, or with a reason.`).toEqual([]);
  });

  it("names no config field that is gone", () => {
    const gone = Object.keys(FIELD_ENTRIES).filter((field) => !fieldNames.includes(field));
    expect(gone, `FIELD_ENTRIES names a config field that no longer exists: ${gone.join(", ")}. Remove it from server/app-settings/coverage.ts.`).toEqual([]);
  });

  it("names only entries that exist", () => {
    const unknown = Object.entries(FIELD_ENTRIES).flatMap(([field, row]) => ("entries" in row ? row.entries.filter((id) => !entryIds.has(id)).map((id) => `${field} -> ${id}`) : []));
    expect(unknown, `FIELD_ENTRIES names an entry id that the registry does not have: ${unknown.join(", ")}. Fix the id in server/app-settings/coverage.ts.`).toEqual([]);
  });

  it("lists at least one entry for a field that has entries", () => {
    const empty = Object.entries(FIELD_ENTRIES).filter(([, row]) => "entries" in row && row.entries.length === 0).map(([field]) => field);
    expect(empty, `FIELD_ENTRIES lists no entry id for: ${empty.join(", ")}. Name the entries, or give a reason instead.`).toEqual([]);
  });

  it("gives every exclusion a real reason", () => {
    const weak = reasons.filter(([, reason]) => reason.trim().length < REASON_MIN).map(([what]) => what);
    expect(weak, `An exclusion needs a reason of at least ${REASON_MIN} characters: ${weak.join(", ")}.`).toEqual([]);
  });

  it("gives every Settings place an entry or a reason", () => {
    const covered = new Set(entries.map((entry) => entry.where));
    const missing = [...placeIds].filter((place) => !covered.has(place as never) && !(place in PLACE_EXCLUSIONS));
    expect(missing, `Settings place without an app_settings entry: ${missing.join(", ")}. Add an entry with that where, or add the place to PLACE_EXCLUSIONS in server/app-settings/coverage.ts with a reason.`).toEqual([]);
  });

  it("names no place that is gone or already covered", () => {
    const covered = new Set<string>(entries.map((entry) => entry.where));
    const gone = Object.keys(PLACE_EXCLUSIONS).filter((place) => !placeIds.has(place));
    const stale = Object.keys(PLACE_EXCLUSIONS).filter((place) => covered.has(place));
    expect(gone, `PLACE_EXCLUSIONS names a place that does not exist: ${gone.join(", ")}. Remove it from server/app-settings/coverage.ts.`).toEqual([]);
    expect(stale, `PLACE_EXCLUSIONS names a place that now has an entry: ${stale.join(", ")}. Remove it from server/app-settings/coverage.ts.`).toEqual([]);
  });
});
