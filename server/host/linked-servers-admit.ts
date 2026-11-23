// How much work one linked server may hand this one, and how refusals reach the activity record.
import type { LinkRefusal } from "../bot-link/link.ts";

export const ADMIT = { perWindow: 30, windowMs: 60_000, open: 8 } as const;
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

/** A refusal for the limits comes in bursts: each link gets at most one such row in `windowMs`, which counts the
 * refusals since the row before it. Every other refusal is one row. */
export function createRefusalRecord(write: (linkId: string, reason: LinkRefusal, count: number) => void, now: () => number = Date.now) {
  const last = new Map<string, { at: number; held: number }>();
  return {
    refused(linkId: string, reason: LinkRefusal): void {
      if (reason !== "limit") { write(linkId, reason, 1); return; }
      const at = now(), previous = last.get(linkId);
      if (previous && at - previous.at < ADMIT.windowMs) { previous.held += 1; return; }
      write(linkId, reason, (previous?.held ?? 0) + 1);
      last.set(linkId, { at, held: 0 });
    },
    forget(linkId: string): void { last.delete(linkId); },
  };
}
