/** An automation that used to run on a cloud computer that no longer exists (see boat-retirement.ts). It stays paused, and
 * Run now / Test refuse, and so does switching it on, until the person confirms where it runs: only `confirmPlace: true` clears the
 * mark. A plain edit (even one that resends `runOn`) keeps it. */
export const PLACE_LOST_MESSAGE = "This automation used a cloud computer that is gone. Choose where it runs, then try again.";

export class PlaceLostError extends Error {
  readonly status = 409;
  constructor() { super(PLACE_LOST_MESSAGE); this.name = "PlaceLostError"; }
}

/** For an edit of an automation: true when the mark should clear (the person confirmed a place). Throws before anything is
 * changed when a marked automation is switched on without that confirmation. */
export function placeConfirmed(marked: boolean | undefined, patch: { confirmPlace?: unknown; enabled?: unknown }): boolean {
  if (!marked) return false;
  if (patch.confirmPlace === true) return true;
  if (patch.enabled === true) throw new PlaceLostError();
  return false;
}

/** Runs `start`, and says a refused run in the caller's own error type (a 409 with the same words). */
export function placeLostAs<T>(make: new (message: string, status: number) => Error, start: () => T): T {
  try { return start(); }
  catch (error) { throw error instanceof PlaceLostError ? new make(error.message, 409) : error; }
}
