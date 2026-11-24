export const TEXT_SIZE_STEPS = Object.freeze([0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
export const DEFAULT_TEXT_SIZE = 1;

export const isTextSize = (value) => TEXT_SIZE_STEPS.includes(value);
export const normalizeTextSize = (value) => (isTextSize(value) ? value : DEFAULT_TEXT_SIZE);

/** One step up or down from `current`; it stops at the first or last step. */
export function stepTextSize(current, direction) {
  const index = TEXT_SIZE_STEPS.indexOf(normalizeTextSize(current)) + (direction < 0 ? -1 : 1);
  return TEXT_SIZE_STEPS[Math.max(0, Math.min(TEXT_SIZE_STEPS.length - 1, index))];
}

/** The smallest window for a step: `base` times the step above 100 %, never larger than `workArea`. */
export function textSizeMinimum(step, base, workArea) {
  const scale = Math.max(1, normalizeTextSize(step));
  let width = Math.round(base.width * scale), height = Math.round(base.height * scale);
  if (workArea && Number.isFinite(workArea.width) && workArea.width > 0) width = Math.min(width, workArea.width);
  if (workArea && Number.isFinite(workArea.height) && workArea.height > 0) height = Math.min(height, workArea.height);
  return { width, height };
}

/**
 * The text size of the app's main window. `prefs` keeps the step for this device. `contents()` is the page of the
 * window, or null; a small window never reaches this. `changed(step)` tells the pages when the step moves.
 */
export function createTextSize({ prefs, contents, changed = () => {} }) {
  const current = () => normalizeTextSize(prefs.textSize());
  const apply = (target = contents()) => {
    if (target && !target.isDestroyed() && Math.abs(target.getZoomFactor() - current()) > 1e-6) target.setZoomFactor(current());
  };
  const set = (value) => {
    if (!isTextSize(value)) return current();
    const before = current();
    prefs.setTextSize(value);
    apply();
    if (before !== value) changed(value);
    return value;
  };
  return {
    current,
    apply,
    set,
    zoomIn: () => set(stepTextSize(current(), 1)),
    zoomOut: () => set(stepTextSize(current(), -1)),
    reset: () => set(DEFAULT_TEXT_SIZE),
  };
}

const usable = (area) => !!area && Number.isFinite(area.width) && area.width > 0 && Number.isFinite(area.height) && area.height > 0;

/**
 * The text size of the main window, which `window()` names while it is open. A small window never reaches this.
 * With `base`, `fit` keeps the window minimum at `base` times the step, inside `workArea(win)`.
 */
export function createMainTextSize({ prefs, window, base = null, workArea = () => null }) {
  const open = () => { const win = window(); return win && !win.isDestroyed() ? win : null; };
  const fit = ({ grow = false } = {}) => {
    const win = open();
    if (!win || !base) return;
    const area = workArea(win), min = textSizeMinimum(size.current(), base, area);
    const [minWidth, minHeight] = win.getMinimumSize();
    if (minWidth !== min.width || minHeight !== min.height) win.setMinimumSize(min.width, min.height);
    if (!grow || win.isMaximized() || win.isFullScreen()) return;
    const bounds = win.getBounds();
    if (bounds.width >= min.width && bounds.height >= min.height) return;
    const width = Math.max(bounds.width, min.width), height = Math.max(bounds.height, min.height);
    let { x, y } = bounds;
    if (usable(area)) {
      x = Math.max(area.x, Math.min(x, area.x + area.width - width));
      y = Math.max(area.y, Math.min(y, area.y + area.height - height));
    }
    win.setBounds({ x, y, width, height });
  };
  const size = createTextSize({
    prefs: { textSize: () => prefs()?.textSize() ?? DEFAULT_TEXT_SIZE, setTextSize: (step) => prefs()?.setTextSize(step) },
    contents: () => open()?.webContents ?? null,
    changed: (step) => { open()?.webContents.send("text-size:changed", step); fit({ grow: true }); },
  });
  return {
    ...size,
    fit,
    /** Applies the step before the window shows and again on each page it loads: Chromium keeps a zoom per host. */
    attach(contents) {
      size.apply(contents);
      fit({ grow: true });
      for (const event of ["dom-ready", "did-navigate", "did-finish-load"]) contents.on(event, () => size.apply(contents));
    },
  };
}
