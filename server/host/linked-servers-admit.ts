// How much work one linked server may hand this one, and how refusals reach the activity record.

/** `frames`: the hand-off, cancel and result frames a link may send in `windowMs`. `outbox`: while this many frames for
 * it wait unacknowledged, a link's work frames are not taken. `hellos`: the hellos of a link applied in `windowMs`.
 * `chars`: the characters of the frames a link may hand this side to clean in `windowMs`: the cleaning costs time in
 * proportion to them. `exchanges` and `sessions`: the exchanges, and the new sessions among them, a link's joiner may open in `windowMs`. */
export const ADMIT = { perWindow: 30, windowMs: 60_000, open: 8, frames: 150, outbox: 2_000, hellos: 10, chars: 600_000, exchanges: 120, sessions: 10 } as const;
export const BUSY_TEXT = "The other side is busy now, so try again later.";

const WORK_FRAMES: ReadonlySet<unknown> = new Set(["handoff", "cancel", "result"]);
export const kindOf = (frame: unknown): unknown => (frame as { t?: unknown } | null)?.t;
export const isWork = (frame: unknown): boolean => WORK_FRAMES.has(kindOf(frame));

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

/** What each link spent of `limit` in the last `windowMs`. */
export function createFrameBudget(now: () => number = Date.now, limit: number = ADMIT.frames) {
  const spent = new Map<string, Array<{ at: number; frames: number }>>();
  const recent = (linkId: string) => {
    const at = now(), kept = (spent.get(linkId) ?? []).filter((one) => at - one.at < ADMIT.windowMs);
    spent.set(linkId, kept);
    return kept;
  };
  return {
    left(linkId: string): number { return Math.max(0, limit - recent(linkId).reduce((sum, one) => sum + one.frames, 0)); },
    /** Returns what gives the same frames back. */
    spend(linkId: string, frames: number): () => void {
      if (frames <= 0) return () => {};
      const entry = { at: now(), frames };
      recent(linkId).push(entry);
      return () => { const kept = spent.get(linkId) ?? [], at = kept.indexOf(entry); if (at >= 0) kept.splice(at, 1); };
    },
    forget(linkId: string): void { spent.delete(linkId); },
  };
}

/** The exchanges and new sessions of each link's joiner: each call takes one, or says false once the window has none. */
export function createPace(now: () => number = Date.now, limits: { exchanges?: number | undefined; sessions?: number | undefined } = {}) {
  const exchanges = createFrameBudget(now, limits.exchanges ?? ADMIT.exchanges);
  const sessions = createFrameBudget(now, limits.sessions ?? ADMIT.sessions);
  const one = (budget: ReturnType<typeof createFrameBudget>, linkId: string) => { if (budget.left(linkId) < 1) return false; budget.spend(linkId, 1); return true; };
  return {
    exchange: (linkId: string) => one(exchanges, linkId),
    session: (linkId: string) => one(sessions, linkId),
    forget(linkId: string): void { exchanges.forget(linkId); sessions.forget(linkId); },
  };
}

/** The frames of one exchange that a link takes: from the first, up to the first work frame its budget has no room for,
 * or up to the first work frame while `full`, or up to the first frame whose `cost` its character budget has no room for.
 * A frame costs at most the whole budget, so one frame always fits in an empty window. Of its hellos only the last is
 * kept, and it goes first in `frames` once the link's hello and character budgets have room: at this exchange or a later one. */
export function createIntake(now: () => number = Date.now, limits: { frames?: number | undefined; hellos?: number | undefined; chars?: number | undefined } = {}, cost: (frame: unknown) => number = () => 0) {
  const work = createFrameBudget(now, limits.frames ?? ADMIT.frames);
  const hellos = createFrameBudget(now, limits.hellos ?? ADMIT.hellos);
  const charMax = limits.chars ?? ADMIT.chars;
  const chars = createFrameBudget(now, charMax);
  const waiting = new Map<string, { frame: unknown; chars?: number }>();
  const priced = (frame: unknown) => Math.min(Math.max(0, Math.ceil(cost(frame))), charMax);
  return {
    take(linkId: string, frames: readonly unknown[], full: boolean): { count: number; frames: unknown[]; undo(): void } {
      let room = full ? 0 : work.left(linkId), charRoom = chars.left(linkId), count = 0, spent = 0, spentChars = 0;
      const taken: unknown[] = [];
      for (const frame of frames) {
        if (isWork(frame)) {
          if (room === 0) break;
          const price = priced(frame);
          if (price > charRoom) break;
          room -= 1;
          spent += 1;
          charRoom -= price;
          spentChars += price;
        }
        count += 1;
        if (kindOf(frame) === "hello") waiting.set(linkId, { frame });
        else taken.push(frame);
      }
      const undoFrames = work.spend(linkId, spent), undoChars = chars.spend(linkId, spentChars);
      let undoHello = () => {};
      const hello = waiting.get(linkId);
      const helloChars = hello && hellos.left(linkId) > 0 ? (hello.chars ??= priced(hello.frame)) : 0;
      if (hello !== undefined && hellos.left(linkId) > 0 && chars.left(linkId) >= helloChars) {
        hellos.spend(linkId, 1);
        undoHello = chars.spend(linkId, helloChars);
        waiting.delete(linkId);
        taken.unshift(hello.frame);
      }
      return { count, frames: taken, undo: () => { undoFrames(); undoChars(); undoHello(); } };
    },
    forget(linkId: string): void { work.forget(linkId); hellos.forget(linkId); chars.forget(linkId); waiting.delete(linkId); },
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
