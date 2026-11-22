/** An automation moved off a cloud computer that is gone stays paused until the person confirms where it runs. Saving it
 * never confirms: only an explicit tick does (server/place-lost.ts refuses anything else). */
export function confirmPlaceInput(automation: { placeLost?: true } | undefined, ticked: boolean): { confirmPlace?: true } {
  return automation?.placeLost && ticked ? { confirmPlace: true } : {};
}
