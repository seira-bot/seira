import { Bug, Mic } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareVersions, noteVersion, RELEASE_NOTES, releaseNoteKeys, releaseNotesHint, releaseNotesUrl, releaseNotesView, VERSIONS_KEY, type ReleaseNote } from "./release-notes";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const item = (id: string) => ({ id, icon: Bug });
const NOTES: ReleaseNote[] = [
  { version: "0.1.184", items: [item("a1"), item("a2")] },
  { version: "0.1.182", items: [item("b1"), item("b2"), item("b3")] },
  { version: "0.1.181", items: [item("c1"), item("c2"), item("c3")] },
  { version: "0.1.180", items: [item("d1")] },
];

describe("release notes data", () => {
  it("starts with 0.1.180 and its four items in order", () => {
    expect(RELEASE_NOTES[0]!.version).toBe("0.1.180");
    expect(RELEASE_NOTES[0]!.items.map(entry => entry.id)).toEqual(["bugReport", "longChats", "fasterStart", "liveYes"]);
    expect(RELEASE_NOTES[0]!.items[3]!.icon).toBe(Mic);
  });
  it("names the strings of an item, the hint and the tag link", () => {
    expect(releaseNoteKeys("bugReport")).toEqual({ title: "releaseNotes.items.bugReport.title", body: "releaseNotes.items.bugReport.body" });
    expect(releaseNotesHint("0.1.180")).toBe("release-notes:0.1.180");
    expect(releaseNotesHint("0.1.180").length).toBeLessThanOrEqual(60);
    expect(releaseNotesUrl("0.1.180")).toBe("https://github.com/seira-bot/seira/releases/tag/v0.1.180");
  });
});

describe("compareVersions", () => {
  it("compares numeric dot parts and refuses the rest", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.1.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("dev", "0.1.1")).toBeNull();
    expect(compareVersions("0.1.1", "")).toBeNull();
  });
});

describe("noteVersion", () => {
  it("records a fresh install with its own version as first", () => {
    expect(noteVersion("0.1.180", false)).toEqual({ first: "0.1.180", last: "0.1.180", before: null });
    expect(JSON.parse(storage.get(VERSIONS_KEY)!)).toEqual({ first: "0.1.180", last: "0.1.180", before: null });
  });
  it("records an empty first for a profile that ran an unknown earlier version", () => {
    expect(noteVersion("0.1.180", true)).toEqual({ first: "", last: "0.1.180", before: null });
  });
  it("moves last to before on an update and is idempotent for the same version", () => {
    noteVersion("0.1.179", false);
    expect(noteVersion("0.1.180", false)).toEqual({ first: "0.1.179", last: "0.1.180", before: "0.1.179" });
    const stored = storage.get(VERSIONS_KEY);
    expect(noteVersion("0.1.180", false)).toEqual({ first: "0.1.179", last: "0.1.180", before: "0.1.179" });
    expect(storage.get(VERSIONS_KEY)).toBe(stored);
  });
  it("does not crash when storage throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(noteVersion("0.1.180", true)).toEqual({ first: "", last: "0.1.180", before: null });
  });
  it("starts again from a damaged record", () => {
    storage.set(VERSIONS_KEY, "{not json");
    expect(noteVersion("0.1.180", false)).toEqual({ first: "0.1.180", last: "0.1.180", before: null });
  });
});

describe("releaseNotesView", () => {
  it("shows nothing on a fresh install of the version", () => {
    expect(releaseNotesView({ first: "0.1.180", last: "0.1.180", before: null }, "0.1.180")).toBeNull();
  });
  it("shows the four items after an update from 0.1.179", () => {
    const view = releaseNotesView({ first: "0.1.179", last: "0.1.180", before: "0.1.179" }, "0.1.180");
    expect(view?.version).toBe("0.1.180");
    expect(view?.from).toBe("0.1.179");
    expect(view?.items.map(entry => entry.id)).toEqual(["bugReport", "longChats", "fasterStart", "liveYes"]);
  });
  it("shows the current items without a from when the earlier version is unknown", () => {
    const view = releaseNotesView({ first: "", last: "0.1.180", before: null }, "0.1.180");
    expect(view?.from).toBeNull();
    expect(view?.items).toHaveLength(4);
  });
  it("shows nothing when the version has no entry", () => {
    expect(releaseNotesView({ first: "0.1.179", last: "0.1.183", before: "0.1.179" }, "0.1.183")).toBeNull();
  });
  it("merges skipped versions newest first and keeps at most six items", () => {
    const view = releaseNotesView({ first: "", last: "0.1.184", before: "0.1.180" }, "0.1.184", NOTES);
    expect(view?.from).toBe("0.1.180");
    expect(view?.items.map(entry => entry.id)).toEqual(["a1", "a2", "b1", "b2", "b3", "c1"]);
  });
  it("leaves out versions at or before the one run before", () => {
    const view = releaseNotesView({ first: "", last: "0.1.182", before: "0.1.181" }, "0.1.182", NOTES);
    expect(view?.items.map(entry => entry.id)).toEqual(["b1", "b2", "b3"]);
  });
  it("shows only the current entry after a downgrade", () => {
    const view = releaseNotesView({ first: "", last: "0.1.180", before: "0.1.184" }, "0.1.180", NOTES);
    expect(view?.from).toBeNull();
    expect(view?.items.map(entry => entry.id)).toEqual(["d1"]);
  });
  it("shows nothing for a development build", () => {
    expect(releaseNotesView({ first: "", last: "dev", before: "0.1.180" }, "dev")).toBeNull();
  });
});
