// The startup steps and the glow line that follows them. Pure: the page and the node tests share it.

/** Position of each real startup step on the line, 0..1. Steps come in this order. */
export const STEP_AT = Object.freeze({ shown: 0.1, engine: 0.4, window: 0.62, loaded: 0.84 });
export const STEP_NAMES = Object.freeze(Object.keys(STEP_AT));
/** Where the line waits after the last step, until the page is painted. */
export const WAIT_CAP = 0.94;
export const FINISH_MS = 240;

const EASE_MS = 3200;
const FOLLOW_MS = 140;
const FILL_MS = 55;
const START_AT = 0.06;
const clamp = (value) => Math.max(0, Math.min(1, value));

export function createLine({ reduced = false } = {}) {
  let floor = START_AT, rank = -1, shown = 0, target = 0, finished = false;
  const ceiling = () => (rank + 1 < STEP_NAMES.length ? STEP_AT[STEP_NAMES[rank + 1]] - 0.03 : WAIT_CAP);
  return {
    reach(step) {
      const at = STEP_NAMES.indexOf(step);
      if (at <= rank) return false;
      rank = at; floor = STEP_AT[step];
      return true;
    },
    finish() { finished = true; },
    get finished() { return finished; },
    get position() { return shown; },
    tick(dt) {
      if (finished) target = 1;
      else if (reduced) target = floor;
      else {
        target = Math.max(target, floor);
        target += (ceiling() - target) * (1 - Math.exp(-dt / EASE_MS));
      }
      const wanted = reduced ? target : shown + (target - shown) * (1 - Math.exp(-dt / (finished ? FILL_MS : FOLLOW_MS)));
      shown = clamp(Math.max(shown, wanted));
      if (finished && shown > 0.995) shown = 1;
      return shown;
    },
  };
}

/** Where Seira looks while the line head is at p: along the line, slightly down. */
export const eyeTarget = (p) => [-0.72 + 1.44 * p, 0.72];
