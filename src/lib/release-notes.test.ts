import { Bug, Mic } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import { compareVersions, noteVersion, RELEASE_NOTES, releaseNoteKeys, releaseNotesHint, releaseNotesUrl, releaseNotesView, VERSIONS_KEY, whatsNewMenuAction, type ReleaseNote } from "./release-notes";

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
  it("starts with 0.1.192 and its five items in order", () => {
    expect(RELEASE_NOTES[0]!.version).toBe("0.1.192");
    expect(RELEASE_NOTES[0]!.items.map(entry => entry.id)).toEqual(["appIcon", "textSize", "sleepWhenIdle", "glanceWayland", "backupCheck"]);
  });
  it("keeps 0.1.191 with its five items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.191")!;
    expect(entry.items.map(item => item.id)).toEqual(["glance", "powerButton", "uiMap", "hermesExport", "backupParts"]);
  });
  it("keeps 0.1.190 with its two items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.190")!;
    expect(entry.items.map(item => item.id)).toEqual(["inboxFirst", "providerInUse"]);
  });
  it("keeps 0.1.189 with its three items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.189")!;
    expect(entry.items.map(item => item.id)).toEqual(["windowRecovers", "updateCheckHonest", "serverSetupGuide"]);
  });
  it("keeps 0.1.188 with its two items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.188")!;
    expect(entry.items.map(item => item.id)).toEqual(["boatGone", "memoryForBots"]);
  });
  it("keeps 0.1.187 with its six items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.187")!;
    expect(entry.items.map(item => item.id)).toEqual(["callView", "chosenFolders", "providerMenu", "fullChat", "departmentAccess", "pictures"]);
  });
  it("keeps 0.1.186 with its six items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.186")!;
    expect(entry.items.map(item => item.id)).toEqual(["installOwnServer", "codexImages", "aiSettings", "boardDone", "appsFeatured", "serverRename"]);
  });
  it("keeps 0.1.185 with its six items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.185")!;
    expect(entry.items.map(item => item.id)).toEqual(["teamSuggestion", "usageRing", "appsConnected", "phonePush", "socialRepliz", "linuxDesktop"]);
  });
  it("keeps 0.1.184 with its six items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.184")!;
    expect(entry.items.map(item => item.id)).toEqual(["aiImport", "board", "botWorkflows", "turnActivity", "appsInChat", "sendSetting"]);
  });
  it("keeps 0.1.183 with its four items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.183")!;
    expect(entry.items.map(item => item.id)).toEqual(["workflows", "drawFromReply", "copyCode", "personLook"]);
  });
  it("keeps 0.1.182 with its one item", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.182")!;
    expect(entry.items.map(item => item.id)).toEqual(["seiraName"]);
  });
  it("keeps 0.1.181 with its six items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.181")!;
    expect(entry.items.map(item => item.id)).toEqual(["aiPool", "connectOneClick", "backupName", "claudeAccounts", "whatsNew", "flatpakEngine"]);
  });
  it("keeps 0.1.180 with its four items in order", () => {
    const entry = RELEASE_NOTES.find(note => note.version === "0.1.180")!;
    expect(entry.items.map(item => item.id)).toEqual(["bugReport", "longChats", "fasterStart", "liveYes"]);
    expect(entry.items[3]!.icon).toBe(Mic);
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
    expect(releaseNotesView({ first: "0.1.178", last: "0.1.179", before: "0.1.178" }, "0.1.179")).toBeNull();
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

describe("whatsNewMenuAction", () => {
  const popupOf = (action: ReturnType<typeof whatsNewMenuAction>) => {
    if (action.kind !== "popup") throw new Error(`expected a popup, got ${action.url}`);
    return action.view;
  };
  it("shows the entry of the running version", () => {
    expect(popupOf(whatsNewMenuAction("0.1.182", NOTES))).toMatchObject({ version: "0.1.182", from: null });
  });
  it("shows the newest older entry when the version has none", () => {
    expect(popupOf(whatsNewMenuAction("0.1.183", NOTES)).version).toBe("0.1.182");
    expect(popupOf(whatsNewMenuAction("0.1.190", NOTES)).version).toBe("0.1.184");
  });
  it("shows the newest entry for a build that has no number", () => {
    expect(popupOf(whatsNewMenuAction("dev", NOTES)).version).toBe("0.1.184");
  });
  it("opens the release page when every entry is newer", () => {
    expect(whatsNewMenuAction("0.1.179", NOTES)).toEqual({ kind: "link", url: "https://github.com/seira-bot/seira/releases/tag/v0.1.179" });
  });
  it("opens the releases page when there are no entries and no number", () => {
    expect(whatsNewMenuAction("dev", [])).toEqual({ kind: "link", url: "https://github.com/seira-bot/seira/releases" });
  });
  it("shows at most six items", () => {
    const many: ReleaseNote[] = [{ version: "0.1.190", items: Array.from({ length: 9 }, (_, i) => item(`x${i}`)) }];
    expect(popupOf(whatsNewMenuAction("0.1.190", many)).items).toHaveLength(6);
  });
});

describe("release guard", () => {
  it("has a release-notes entry for the package version", () => {
    const version = pkg.version;
    expect(RELEASE_NOTES.some(note => note.version === version), `add a RELEASE_NOTES entry for ${version} in src/lib/release-notes.ts`).toBe(true);
  });
  it("lists the package version first", () => {
    expect(RELEASE_NOTES[0]!.version, "put the entry for the package version first in RELEASE_NOTES").toBe(pkg.version);
  });
});
