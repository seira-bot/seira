import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { UI_PLACES, type UiPlace } from "./ui-places.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLACES: readonly UiPlace[] = UI_PLACES;
const EN = JSON.parse(readFileSync(join(ROOT, "src/locales/en.json"), "utf8")) as Record<string, string>;

function* sources(path: string): Generator<string> {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) if (name !== "node_modules" && !name.endsWith(".json")) yield* sources(join(path, name));
  } else if (/\.tsx?$/.test(path) && !/\.test\.|\.d\.ts$|\/testing\//.test(path)) yield path;
}

const text = [...sources(join(ROOT, "src"))].map((file) => readFileSync(file, "utf8")).join("\n");
const found = (pattern: RegExp) => new Set([...text.matchAll(pattern)].map((match) => match[1]!));
/** Both ways a source file sets the attribute: a literal, or the typed `ui("…")` helper. */
const UI_ANCHORS = new Set([...found(/data-ui="([^"]+)"/g), ...found(/\bui\("([^"]+)"\)/g)]);
/** An existing `data-tour` anchor, set on the element or through a `tourId` prop. */
const TOUR = new Set([...text.matchAll(/data-tour"?(?:=\{?|:\s*)"([^"]+)"|\btourId="([^"]+)"/g)].flatMap((match) => [match[1], match[2]].filter((value): value is string => Boolean(value))));

describe("UI map", () => {
  it("has unique ids", () => {
    const ids = PLACES.map((place) => place.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it("finds every anchor in the UI", () => {
    const missing = PLACES.filter((place) => (place.tour ? !TOUR.has(place.tour) : !UI_ANCHORS.has(place.id))).map((place) => place.tour ? `${place.id} (data-tour ${place.tour})` : place.id);
    expect(missing).toEqual([]);
  });

  it("has an entry for every data-ui in the UI", () => {
    const known = new Set(PLACES.filter((place) => !place.tour).map((place) => place.id));
    expect([...UI_ANCHORS].filter((anchor) => !known.has(anchor))).toEqual([]);
  });

  it("takes each label from the English catalog when it has a key", () => {
    const wrong = PLACES.filter((place) => place.labelKey && EN[place.labelKey] !== place.label).map((place) => `${place.id}: ${place.labelKey} is ${JSON.stringify(EN[place.labelKey!])}`);
    expect(wrong).toEqual([]);
  });

  it("points every parent at an entry", () => {
    const ids = new Set(PLACES.map((place) => place.id));
    expect(PLACES.filter((place) => place.parent && !ids.has(place.parent)).map((place) => place.id)).toEqual([]);
  });

  it("gives every entry a position and clicks, and a Simple path only to Advanced controls", () => {
    expect(PLACES.filter((place) => !place.position || place.steps.length === 0).map((place) => place.id)).toEqual([]);
    expect(PLACES.filter((place) => place.simplePath && !place.advanced).map((place) => place.id)).toEqual([]);
  });
});
