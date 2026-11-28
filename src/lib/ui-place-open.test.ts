import { describe, expect, it } from "vitest";

import { UI_PLACES } from "../../shared/ui-places";
import { SETTINGS_PLACES } from "../../shared/settings-places";
import { anchorOf, openActions, placeChain, placeMode, placeSteps, settingsOpenAction, settingsPlaceTarget, uiPlaceById } from "./ui-place-open";

const place = (id: string) => uiPlaceById(id)!;

describe("uiPlaceById", () => {
  it("finds a mapped id and nothing else", () => {
    expect(uiPlaceById("board.new-todo")?.label).toBe("New todo");
    expect(uiPlaceById("nope")).toBeUndefined();
    expect(uiPlaceById("__proto__")).toBeUndefined();
    expect(uiPlaceById("constructor")).toBeUndefined();
    expect(uiPlaceById(42)).toBeUndefined();
    expect(uiPlaceById(undefined)).toBeUndefined();
  });
});

describe("anchorOf", () => {
  it("uses the data-ui id, or the data-tour anchor the entry names", () => {
    expect(anchorOf(place("board.new-todo"))).toEqual({ attr: "ui", value: "board.new-todo" });
    expect(anchorOf(place("automations.page"))).toEqual({ attr: "tour", value: "automations-page" });
  });
});

describe("placeChain", () => {
  it("lists the place, then its parents", () => {
    expect(placeChain(place("sidebar.new-bot")).map((one) => one.id)).toEqual(["sidebar.new-bot", "sidebar.new"]);
    expect(placeChain(place("panel.memory")).map((one) => one.id)).toEqual(["panel.memory", "panel.tab-library", "chat.bot-name"]);
  });

  it("ends for every entry of the map", () => {
    for (const one of UI_PLACES) expect(placeChain(one).length).toBeGreaterThan(0);
  });
});

describe("openActions", () => {
  it("opens the page or panel a place sits in", () => {
    expect(openActions(place("board.new-todo"))).toEqual([{ type: "showBoard" }]);
    expect(openActions(place("automations.calendar"))).toEqual([{ type: "showRoutines", view: "calendar" }]);
    expect(openActions(place("automations.page"))).toEqual([{ type: "showRoutines" }]);
    expect(openActions(place("workflow.palette"))).toEqual([{ type: "showRoutines", view: "workflows" }]);
    expect(openActions(place("apps.search"))).toEqual([{ type: "togglePlugins", open: true }]);
    expect(openActions(place("apps.mcp"))).toEqual([{ type: "togglePlugins", open: true, surface: "mcp" }]);
    expect(openActions(place("files.page"))).toEqual([{ type: "showFiles" }]);
    expect(openActions(place("panel.tab-details"))).toEqual([{ type: "toggleSettings", open: true }]);
    expect(openActions(place("composer.field"))).toEqual([{ type: "showChat" }]);
    expect(openActions(place("sidebar.search"))).toEqual([]);
  });

  it("never describes a click: only navigation actions", () => {
    const allowed = new Set(["showRoutines", "showBoard", "showFiles", "togglePlugins", "toggleSettings", "showChat"]);
    for (const one of UI_PLACES) for (const action of openActions(one)) expect(allowed.has(action.type)).toBe(true);
  });
});

describe("placeMode and placeSteps", () => {
  it("offers no button for an Advanced-only place in Simple mode, and gives the Simple path", () => {
    expect(placeMode(place("chat.find"), false)).toEqual({ button: false, why: "advanced" });
    expect(placeMode(place("chat.find"), true)).toEqual({ button: true });
    expect(placeSteps(place("chat.find"), false)).toEqual([place("chat.find").simplePath]);
    expect(placeSteps(place("chat.find"), true)).toEqual(place("chat.find").steps);
  });

  it("falls back to the clicks when an Advanced-only place has no Simple path", () => {
    const one = UI_PLACES.find((entry) => "advanced" in entry && entry.advanced && !("simplePath" in entry))!;
    expect(placeSteps(one, false)).toEqual(one.steps);
  });

  it("uses the Advanced clicks when the entry names different ones", () => {
    expect(placeSteps(place("sidebar.files"), true)).toEqual(place("sidebar.files").advancedSteps);
    expect(placeSteps(place("sidebar.files"), false)).toEqual(place("sidebar.files").steps);
  });

  it("offers a button for a place that every mode shows", () => {
    expect(placeMode(place("board.new-todo"), false)).toEqual({ button: true });
  });
});

describe("settingsPlaceTarget", () => {
  it("gives the page and the block of a Settings row, and the page alone for a page", () => {
    expect(settingsPlaceTarget("ai-pool")).toEqual({ id: "ai-pool", page: "ai", anchor: "ai-pool" });
    expect(settingsPlaceTarget("page:ai")).toEqual({ id: "page:ai", page: "ai" });
    expect(settingsPlaceTarget("vault")).toEqual({ id: "vault", page: "vault" });
  });

  it("knows no id of a row that jumps out of Settings, and no unknown or odd id", () => {
    for (const id of ["apps", "automations", "bot", "shortcuts", "page:nope", "nope", "__proto__", "constructor", "", 7, undefined, null]) expect(settingsPlaceTarget(id), String(id)).toBeUndefined();
  });

  it("knows every Settings place the server can show", () => {
    for (const place of SETTINGS_PLACES) {
      const shown = place.path.startsWith("Settings") && !["advanced-mode", "sidebar"].includes(place.id);
      expect(settingsPlaceTarget(place.id) !== undefined, place.id).toBe(shown);
    }
  });

  it("shares no id with the UI map", () => {
    for (const place of UI_PLACES) expect(settingsPlaceTarget(place.id), place.id).toBeUndefined();
  });
});

describe("settingsOpenAction", () => {
  it("opens Settings on the page with the block to scroll to", () => {
    expect(settingsOpenAction(settingsPlaceTarget("ai-pool")!)).toEqual({ type: "toggleAppSettings", open: true, section: "ai", anchor: "ai-pool" });
    expect(settingsOpenAction(settingsPlaceTarget("page:ai")!)).toEqual({ type: "toggleAppSettings", open: true, section: "ai" });
  });
});
