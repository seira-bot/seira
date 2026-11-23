import { describe, expect, it } from "vitest";
import { confirmPlaceInput } from "./place-lost";

describe("confirmPlaceInput", () => {
  it("confirms only a moved automation whose confirmation was ticked", () => {
    expect(confirmPlaceInput({ placeLost: true }, true)).toEqual({ confirmPlace: true });
  });
  it("keeps the mark when it is only saved, renamed or left unticked", () => {
    expect(confirmPlaceInput({ placeLost: true }, false)).toEqual({});
  });
  it("sends nothing for a new or an ordinary automation, even if ticked", () => {
    expect(confirmPlaceInput(undefined, true)).toEqual({});
    expect(confirmPlaceInput({}, true)).toEqual({});
  });
});
