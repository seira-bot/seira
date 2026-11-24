// How much work one linked server may hand this one, and how refusals reach the activity record.

/** `frames`: the hand-off, cancel and result frames a link may send in `windowMs`. `outbox`: while this many frames for
 * it wait unacknowledged, a link's work frames are not taken. `hellos`: the hellos of a link read in `windowMs`.
 * `chars`: the characters of the frames a link may hand this side to clean in `windowMs`: the cleaning costs time in
 * proportion to them. `bytes`: the bytes of a link's requests or answers this side reads in `windowMs`: reading and
 * parsing them costs time in proportion to them. `sendBytes`: the bytes of the frames this side sends a link in
 * `windowMs`, half of `bytes`, so an honest side's work frames stay within the other side's. `exchanges` and `sessions`: the
 * exchanges, and the new sessions among them, a link's joiner may open in `windowMs`. */
export const ADMIT = { perWindow: 30, windowMs: 60_000, open: 8, frames: 150, outbox: 2_000, hellos: 10, chars: 300_000, bytes: 6_000_000, sendBytes: 3_000_000,
  exchanges: 120, sessions: 10 } as const;
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
  const left = (linkId: string) => Math.max(0, limit - recent(linkId).reduce((sum, one) => sum + one.frames, 0));
  return {
    left,
    /** Returns what gives the same frames back. `at`: when the spending counts from; a later time keeps it in the window
     * past this window's end. */
    spend(linkId: string, frames: number, at: number = now()): () => void {
      if (frames <= 0) return () => {};
      const entry = { at, frames };
      recent(linkId).push(entry);
      return () => { const kept = spent.get(linkId) ?? [], index = kept.indexOf(entry); if (index >= 0) kept.splice(index, 1); };
    },
    /** Takes `frames` back from what the link spent, the newest spending first. */
    giveBack(linkId: string, frames: number): void {
      let rest = frames;
      const kept = recent(linkId);
      for (let i = kept.length - 1; i >= 0 && rest > 0; i--) {
        const one = kept[i]!, take = Math.min(one.frames, rest);
        one.frames -= take;
        rest -= take;
        if (one.frames <= 0) kept.splice(i, 1);
      }
    },
    /** How long until `need` fits: 0 when it fits now, a whole window when it never does. */
    waitFor(linkId: string, need: number): number {
      let room = left(linkId);
      if (room >= need) return 0;
      const at = now();
      for (const one of [...recent(linkId)].sort((x, y) => x.at - y.at)) {
        room += one.frames;
        if (room >= need) return Math.max(0, one.at + ADMIT.windowMs - at);
      }
      return ADMIT.windowMs;
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

/** A frame as the intake reads it: the frame to act on (null for one that does not parse) and its price in characters. */
export type IntakeRead = { frame: unknown; price: number };
const asIs = (frame: unknown): IntakeRead => ({ frame, price: 0 });

/** The frames of one exchange that a link takes: from the first, up to the first work frame its budget has no room for,
 * or up to the first work frame while `full`, or up to the first work frame whose price its character budget has no room
 * for. Each frame taken is read once, with `read`, and goes on as read. A price larger than the character budget fits
 * only an empty window, which then stays full until the whole price is spent, at most one window later. Of its hellos
 * only the last is kept. It is read once the hello budget has room, and goes first in `frames` once the character
 * budget has room for its price: at this exchange or a later one. */
export function createIntake(now: () => number = Date.now, limits: { frames?: number | undefined; hellos?: number | undefined; chars?: number | undefined } = {},
  read: (frame: unknown) => IntakeRead = asIs) {
  const work = createFrameBudget(now, limits.frames ?? ADMIT.frames);
  const hellos = createFrameBudget(now, limits.hellos ?? ADMIT.hellos);
  const charMax = limits.chars ?? ADMIT.chars;
  const chars = createFrameBudget(now, charMax);
  const waiting = new Map<string, { raw: unknown; read?: IntakeRead }>();
  const priceOf = (one: IntakeRead) => Math.min(Math.max(0, Math.ceil(one.price) || 0), 2 * charMax);
  const fits = (price: number, room: number) => Math.min(price, charMax) <= room;
  const charge = (linkId: string, price: number) => {
    const first = chars.spend(linkId, Math.min(price, charMax)), rest = chars.spend(linkId, price - charMax, now() + ADMIT.windowMs);
    return () => { first(); rest(); };
  };
  return {
    take(linkId: string, frames: readonly unknown[], full: boolean): { count: number; frames: unknown[]; undo(): void } {
      let room = full ? 0 : work.left(linkId), charRoom = chars.left(linkId), count = 0, spent = 0, spentChars = 0;
      const taken: unknown[] = [];
      for (const frame of frames) {
        if (kindOf(frame) === "hello") waiting.set(linkId, { raw: frame });
        else if (isWork(frame)) {
          if (room === 0) break;
          const one = read(frame), price = priceOf(one);
          if (!fits(price, charRoom)) break;
          room -= 1;
          spent += 1;
          charRoom -= price;
          spentChars += price;
          taken.push(one.frame);
        } else taken.push(read(frame).frame);
        count += 1;
      }
      const undoFrames = work.spend(linkId, spent), undoChars = charge(linkId, spentChars);
      let undoHello = () => {};
      const hello = waiting.get(linkId);
      if (hello && !hello.read && hellos.left(linkId) > 0) {
        hellos.spend(linkId, 1);
        hello.read = read(hello.raw);
      }
      if (hello?.read && hello.read.frame === null) waiting.delete(linkId);
      else if (hello?.read && fits(priceOf(hello.read), chars.left(linkId))) {
        undoHello = charge(linkId, priceOf(hello.read));
        waiting.delete(linkId);
        taken.unshift(hello.read.frame);
      }
      return { count, frames: taken, undo: () => { undoFrames(); undoChars(); undoHello(); } };
    },
    forget(linkId: string): void { work.forget(linkId); hellos.forget(linkId); chars.forget(linkId); waiting.delete(linkId); },
  };
}

/** How this side paces what it sends a link, so an honest side never meets the other side's limits. The bytes of the
 * work frames sent in `windowMs` stay within `bytes`; a hello and the other frames without work are outside it. After a batch whose work frames the other side took none of, no work
 * frame goes for a pause that starts at `pauseMs` and doubles at each such batch up to `pauseMax`. The frames before the
 * first work frame that must wait always go, so a batch is always the start of what waits. One work frame larger than
 * `bytes` goes alone, in an empty window. */
export function createSendPace(now: () => number = Date.now, limits: { bytes?: number | undefined; pauseMs?: number; pauseMax?: number } = {}) {
  const byteMax = limits.bytes ?? ADMIT.sendBytes, pauseMs = limits.pauseMs ?? 5_000, pauseMax = limits.pauseMax ?? 10_000;
  const sent = createFrameBudget(now, byteMax);
  const paused = new Map<string, { until: number; next: number }>();
  const sizes = new WeakMap<object, number>();
  const sizeOf = (frame: unknown): number => {
    if (typeof frame !== "object" || frame === null) return Buffer.byteLength(JSON.stringify(frame) ?? "");
    let size = sizes.get(frame);
    if (size === undefined) { size = Buffer.byteLength(JSON.stringify(frame)); sizes.set(frame, size); }
    return size;
  };
  return {
    /** How many of `frames`, from the first, go now, and when some must wait, in how many milliseconds more may go. */
    next(linkId: string, frames: ReadonlyArray<{ frame: unknown }>): { count: number; waitMs: number } {
      const at = now(), until = paused.get(linkId)?.until ?? 0;
      let room = sent.left(linkId), count = 0;
      for (const { frame } of frames) {
        const size = sizeOf(frame);
        if (isWork(frame)) {
          if (until > at) return { count, waitMs: until - at };
          if (size > room && !(count === 0 && room === byteMax)) return { count, waitMs: Math.max(1, sent.waitFor(linkId, Math.min(size, byteMax))) };
        }
        room -= size;
        count += 1;
      }
      return { count, waitMs: 0 };
    },
    sent(linkId: string, frames: ReadonlyArray<{ frame: unknown }>): void { sent.spend(linkId, frames.reduce((sum, one) => sum + sizeOf(one.frame), 0)); },
    /** The other side took `taken` of the `work` work frames of the last batch. */
    took(linkId: string, work: number, taken: number): void {
      if (work === 0) return;
      if (taken > 0) { paused.delete(linkId); return; }
      const next = paused.get(linkId)?.next ?? pauseMs;
      paused.set(linkId, { until: now() + next, next: Math.min(next * 2, pauseMax) });
    },
    forget(linkId: string): void { sent.forget(linkId); paused.delete(linkId); },
  };
}

/** `log` for one link: at most `lines` lines in `windowMs`, then one line in a window that says the rest were dropped. */
export function limitLog(log: (line: string) => void, now: () => number = Date.now, lines = 20): (line: string) => void {
  const passed: number[] = [];
  let told = Number.NEGATIVE_INFINITY;
  return (line) => {
    const at = now();
    while (passed.length > 0 && at - passed[0]! >= ADMIT.windowMs) passed.shift();
    if (passed.length < lines) { passed.push(at); log(line); return; }
    if (at - told < ADMIT.windowMs) return;
    told = at;
    log(`linked servers: a link wrote more than ${lines} lines in a minute; the rest were dropped`);
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
