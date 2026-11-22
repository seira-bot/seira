import { describe, expect, it } from "vitest";
import { PLACE_LOST_MESSAGE, PlaceLostError, placeChosen, placeLostAs } from "./place-lost.ts";

class Refusal extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

describe("an automation whose cloud computer is gone", () => {
  it("is cleared by picking a place or switching it on, not by any other edit", () => {
    expect(placeChosen({ runOn: "seira" })).toBe(true);
    expect(placeChosen({ enabled: true })).toBe(true);
    expect(placeChosen({ enabled: false })).toBe(false);
    expect(placeChosen({})).toBe(false);
  });

  it("is said in the caller's own error type with the same words and a 409", () => {
    expect(() => placeLostAs(Refusal, () => { throw new PlaceLostError(); })).toThrow(expect.objectContaining({ message: PLACE_LOST_MESSAGE, status: 409, name: "Error" }));
    expect(placeLostAs(Refusal, () => 7)).toBe(7);
    const other = new Error("disk full");
    expect(() => placeLostAs(Refusal, () => { throw other; })).toThrow(other);
  });
});
