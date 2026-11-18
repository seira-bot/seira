export const FULL_FRAME_MS = 1000 / 60;
export const FRAME_SLACK_MS = 4;
export const SMALL_MASCOT_PX = 64;
const SMALL_MASCOT_FRAME_MS = 1000 / 20;

export function nextFrameAt(now: number, interval: number): number {
  if (interval === Infinity) return Infinity;
  return (Math.floor((now + FRAME_SLACK_MS) / interval) + 1) * interval;
}

export function frameFloorMs(sizePx: number): number {
  return sizePx <= SMALL_MASCOT_PX ? SMALL_MASCOT_FRAME_MS : FULL_FRAME_MS;
}
