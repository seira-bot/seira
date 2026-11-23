export const TEXT_SIZE_STEPS = Object.freeze([0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
export const DEFAULT_TEXT_SIZE = 1;

export const isTextSize = (value) => TEXT_SIZE_STEPS.includes(value);
export const normalizeTextSize = (value) => (isTextSize(value) ? value : DEFAULT_TEXT_SIZE);

/** One step up or down from `current`; it stops at the first or last step. */
export function stepTextSize(current, direction) {
  const index = TEXT_SIZE_STEPS.indexOf(normalizeTextSize(current)) + (direction < 0 ? -1 : 1);
  return TEXT_SIZE_STEPS[Math.max(0, Math.min(TEXT_SIZE_STEPS.length - 1, index))];
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
