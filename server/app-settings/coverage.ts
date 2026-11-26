/** A field or place with no entry needs a reason here. */
export type FieldCoverage = { entries: readonly string[] } | { excluded: string };

export const FIELD_ENTRIES: Record<string, FieldCoverage> = {};

export const PLACE_EXCLUSIONS: Record<string, string> = {};
