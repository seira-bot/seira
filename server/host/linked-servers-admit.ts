// How much work one linked server may hand this one, and how refusals reach the activity record.

/** `frames`: the hand-off, cancel and result frames a link may send in `windowMs`, whatever becomes of them. `outbox`:
 * while this many frames for it wait unacknowledged, a link's work frames are not taken. */
export const ADMIT = { perWindow: 30, windowMs: 60_000, open: 8, frames: 150, outbox: 2_000 } as const;
export const BUSY_TEXT = "The other server is busy now, so try again later.";

/** Refuses a hand-off while `open` of the link's hand-offs are at work here, or when the link already had
 * `perWindow` admitted in the last `windowMs`. Only admitted hand-offs count toward the window. */
export function createAdmission(now: () => number = Date.now) {
  const admitted = new Map<string, number[]>();
  return {
    admit(linkId: string, open: number): string | null {
      if (open >= ADMIT.open) return BUSY_TEXT;
      const at = now();
      const recent = (admitted.get(linkId) ?? []).filter((one) => at - one < ADMIT.windowMs);
      admitted.set(linkId, recent);
      if (recent.length >= ADMIT.perWindow) return BUSY_TEXT;
      recent.push(at);
      return null;
    },
    forget(linkId: string): void { admitted.delete(linkId); },
  };
}

/** Takes the work frames of one exchange only when all of them fit in the link's budget for the last `windowMs`. */
export function createFrameBudget(now: () => number = Date.now, limit: number = ADMIT.frames) {
  const spent = new Map<string, Array<{ at: number; frames: number }>>();
  return {
    take(linkId: string, frames: number): boolean {
      if (frames === 0) return true;
      const at = now();
      const recent = (spent.get(linkId) ?? []).filter((one) => at - one.at < ADMIT.windowMs);
      spent.set(linkId, recent);
      if (recent.reduce((sum, one) => sum + one.frames, 0) + frames > limit) return false;
      recent.push({ at, frames });
      return true;
    },
    forget(linkId: string): void { spent.delete(linkId); },
  };
}

/** Refusals come in bursts: each link gets at most one row for them in `windowMs`, which counts the refusals since the
 * row before it. */
export function createRefusalRecord(now: () => number = Date.now) {
  const last = new Map<string, { at: number; held: number }>();
  return {
    /** The count the row for this refusal carries, or null when no row is written for it now. */
    count(linkId: string): number | null {
      const at = now(), previous = last.get(linkId);
      if (previous && at - previous.at < ADMIT.windowMs) { previous.held += 1; return null; }
      last.set(linkId, { at, held: 0 });
      return (previous?.held ?? 0) + 1;
    },
    forget(linkId: string): void { last.delete(linkId); },
  };
}
