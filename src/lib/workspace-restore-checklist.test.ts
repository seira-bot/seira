import { describe, expect, it } from "vitest";
import { hasAutomationItem, readDoneItems, readRestoreChecklist, writeDoneItems } from "./workspace-restore-checklist";

describe("readRestoreChecklist", () => {
  it("returns null when the server sends no list", () => {
    expect(readRestoreChecklist({})).toBeNull();
    expect(readRestoreChecklist({ needsAction: "routines-on" })).toBeNull();
  });
  it("keeps the three known kinds once each, with whole counts of 1 or more", () => {
    expect(readRestoreChecklist({ needsAction: [
      { kind: "routines-on", count: 2 }, { kind: "routines-on", count: 4 }, { kind: "webhooks-on", count: 0 }, { kind: "webhooks-on", count: 1.5 },
      { kind: "app-automations-on", count: 1 }, { kind: "other", count: 1 }, null, "x", { kind: "app-automations-on", count: "3" },
    ] })).toEqual([{ id: "routines-on", count: 2 }, { id: "app-automations-on", count: 1 }]);
  });
  it("adds left-behind from a whole bot count and drops its paths", () => {
    expect(readRestoreChecklist({ needsAction: [], leftBehind: { bots: 2, paths: ["/old/work"] } })).toEqual([{ id: "left-behind", count: 2 }]);
    expect(readRestoreChecklist({ needsAction: [], leftBehind: { bots: 0 } })).toEqual([]);
    expect(readRestoreChecklist({ needsAction: [], leftBehind: null })).toEqual([]);
  });
});

describe("hasAutomationItem", () => {
  it("is false for an empty list or a list with only left-behind work folders", () => {
    expect(hasAutomationItem([])).toBe(false);
    expect(hasAutomationItem([{ id: "left-behind", count: 2 }])).toBe(false);
    expect(hasAutomationItem([{ id: "left-behind", count: 2 }, { id: "webhooks-on", count: 1 }])).toBe(true);
  });
});

describe("done marks", () => {
  const memory = () => { const map = new Map<string, string>(); return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; };
  it("round-trips for one restore and ignores a damaged value", () => {
    const storage = memory();
    writeDoneItems("r1", ["routines-on"], storage);
    expect(readDoneItems("r1", storage)).toEqual(["routines-on"]);
    expect(readDoneItems("r2", storage)).toEqual([]);
    storage.map.set("seira-restore-checklist:r3", "{not json");
    expect(readDoneItems("r3", storage)).toEqual([]);
    storage.map.set("seira-restore-checklist:r4", JSON.stringify([1, "webhooks-on", null]));
    expect(readDoneItems("r4", storage)).toEqual(["webhooks-on"]);
  });
  it("does not throw when storage is blocked", () => {
    expect(() => writeDoneItems("r1", ["x"], { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
    expect(readDoneItems("r1", { getItem: () => { throw new Error("blocked"); } })).toEqual([]);
  });
  it("does not throw when reading the localStorage property itself throws", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      expect(() => writeDoneItems("r1", ["x"])).not.toThrow();
      expect(readDoneItems("r1")).toEqual([]);
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved); else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
