import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createGlanceTray } from "./glance-tray.mjs";

const LABELS = { working: "Working", needsYou: "Needs you", question: "Question", failed: "Failed", finished: "{name} finished" };
const entry = (id, state, line = "") => ({ key: `${id}\nt`, botId: id, threadId: `t-${id}`, name: id, state, line });
const view = (...entries) => ({ entries, active: entries.length > 0, labels: LABELS });

function world() {
  const trays = [], menus = [], opened = [];
  class Tray extends EventEmitter {
    constructor(image) { super(); this.image = image; this.destroyedFlag = false; trays.push(this); }
    isDestroyed() { return this.destroyedFlag; }
    destroy() { this.destroyedFlag = true; }
    setToolTip(tip) { this.tip = tip; }
    setImage(image) { this.image = image; }
    setContextMenu(menu) { this.menu = menu; }
  }
  const state = { hidden: 0 };
  const tray = createGlanceTray({
    Tray, Menu: { buildFromTemplate: (template) => { menus.push(template); return template; } },
    nativeImage: { createEmpty: () => ({ addRepresentation() {} }) },
    t: (key) => key, onOpen: (target) => opened.push(target), onHide: () => { state.hidden++; },
  });
  return { tray, trays, menus, opened, state };
}

test("AC-11 one row per active bot in order, the tray shows only while a bot is active", () => {
  const w = world();
  w.tray.update(view());
  assert.equal(w.trays.length, 0);
  w.tray.update(view(entry("a", "needs", "Wants to run"), entry("b", "working", "Searching")));
  assert.equal(w.trays.length, 1);
  assert.equal(w.trays[0].tip, "native.menu.glance");
  const menu = w.menus.at(-1);
  assert.deepEqual(menu.slice(0, 2).map((row) => row.label), ["a · Needs you · Wants to run", "b · Working · Searching"]);
  assert.equal(menu.at(-2).type, "separator");
  w.tray.update(view());
  assert.equal(w.trays[0].destroyedFlag, true);
});

test("AC-11 a row opens that bot's chat", () => {
  const w = world();
  w.tray.update(view(entry("a", "needs"), entry("b", "working")));
  w.menus.at(-1)[1].click();
  assert.deepEqual(w.opened, [{ botId: "b", threadId: "t-b" }]);
});

test("AC-12 the checkbox turns Glance off", () => {
  const w = world();
  w.tray.update(view(entry("a", "working")));
  const box = w.menus.at(-1).at(-1);
  assert.equal(box.type, "checkbox");
  assert.equal(box.checked, true);
  assert.equal(box.label, "native.menu.glance");
  box.click();
  assert.equal(w.state.hidden, 1);
});

test("the menu is rebuilt only when its rows change", () => {
  const w = world();
  w.tray.update(view(entry("a", "working", "x")));
  const count = w.menus.length;
  w.tray.update(view(entry("a", "working", "x")));
  assert.equal(w.menus.length, count);
  w.tray.update(view(entry("a", "working", "y")));
  assert.equal(w.menus.length, count + 1);
});
