import { describe, expect, it } from "vitest";
import { PLACE_LOST_MESSAGE, PlaceLostError, placeConfirmed, placeLostAs } from "./place-lost.ts";

class Refusal extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

describe("an automation whose cloud computer is gone", () => {
  it("is cleared only by an explicit confirmation, and switching it on without one is refused", () => {
    expect(placeConfirmed(true, { confirmPlace: true })).toBe(true);
    expect(placeConfirmed(true, { confirmPlace: true, enabled: true })).toBe(true);
    expect(() => placeConfirmed(true, { enabled: true })).toThrow(expect.objectContaining({ status: 409, message: expect.stringMatching(/Choose where it runs/) }));
    // An edit that only resends the place, pauses it or renames it keeps the mark.
    expect(placeConfirmed(true, { runOn: "seira" } as object)).toBe(false);
    expect(placeConfirmed(true, { enabled: false })).toBe(false);
    expect(placeConfirmed(true, {})).toBe(false);
    // Nothing to clear, nothing to refuse.
    expect(placeConfirmed(undefined, { enabled: true })).toBe(false);
    expect(placeConfirmed(undefined, { confirmPlace: true })).toBe(false);
  });

  it("is said in the caller's own error type with the same words and a 409", () => {
    expect(() => placeLostAs(Refusal, () => { throw new PlaceLostError(); })).toThrow(expect.objectContaining({ message: PLACE_LOST_MESSAGE, status: 409, name: "Error" }));
    expect(placeLostAs(Refusal, () => 7)).toBe(7);
    const other = new Error("disk full");
    expect(() => placeLostAs(Refusal, () => { throw other; })).toThrow(other);
  });
});
