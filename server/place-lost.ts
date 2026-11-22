/** An automation that used to run on a cloud computer that no longer exists (see boat-retirement.ts). It stays paused, and
 * Run now / Test refuse until the person chooses where it runs: that edit, or switching it back on, clears the mark. */
export const PLACE_LOST_MESSAGE = "This automation used a cloud computer that is gone. Choose where it runs, then try again.";

export class PlaceLostError extends Error {
  readonly status = 409;
  constructor() { super(PLACE_LOST_MESSAGE); this.name = "PlaceLostError"; }
}

/** The person picked a place again or switched the automation on by hand. */
export function placeChosen(patch: { runOn?: unknown; enabled?: unknown }): boolean {
  return patch.runOn !== undefined || patch.enabled === true;
}
