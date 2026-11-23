import { colorDotPng } from "./color-dot.mjs";
import { STATE_COLOR, stateText } from "./glance-model.mjs";

const TRAY_PX = 22;

/**
 * Glance on Linux Wayland: an app cannot place a window there, so the state shows as a tray icon. One menu row per active bot opens its chat.
 * `t`: native strings. `onOpen({ botId, threadId })`. `onHide()` turns Glance off.
 */
export function createGlanceTray({ Tray, Menu, nativeImage, t, onOpen, onHide }) {
  let tray = null, shown = null, current = null;
  const icons = new Map();
  const iconFor = (color) => {
    if (!icons.has(color)) {
      const image = nativeImage.createEmpty();
      for (const scaleFactor of [1, 2]) image.addRepresentation({ scaleFactor, dataURL: colorDotPng(color, TRAY_PX * scaleFactor, TRAY_PX * scaleFactor * 0.7) });
      icons.set(color, image);
    }
    return icons.get(color);
  };
  const rowOf = (entry, labels) => ({ botId: entry.botId, threadId: entry.threadId, label: [entry.name, stateText(entry, labels), entry.line].filter(Boolean).join(" · ") });

  function draw() {
    if (!tray || tray.isDestroyed() || !current) return;
    const name = t("native.menu.glance");
    tray.setToolTip(name);
    tray.setImage(iconFor(current.color));
    tray.setContextMenu(Menu.buildFromTemplate([
      ...current.rows.map((row) => ({ label: row.label, click: () => onOpen({ botId: row.botId, threadId: row.threadId }) })),
      { type: "separator" },
      { label: name, type: "checkbox", checked: true, click: () => onHide() },
    ]));
  }

  const destroy = () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null; shown = null; current = null;
  };

  return {
    /** Shown only while a bot is active; the menu is rebuilt only when its rows change. */
    update(view) {
      if (!view || !view.active) { destroy(); return; }
      const next = { color: STATE_COLOR[view.entries[0].state], rows: view.entries.map((entry) => rowOf(entry, view.labels)) };
      const mark = JSON.stringify(next);
      if (tray && !tray.isDestroyed() && mark === shown) return;
      current = next;
      shown = mark;
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(iconFor(next.color));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      draw();
    },
    relabel() { draw(); },
    destroy,
    exists: () => Boolean(tray && !tray.isDestroyed()),
  };
}
