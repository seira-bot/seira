import { describe, expect, it } from "vitest";

import { cloudAsleepAnswer } from "./dial.ts";

const OLD = "x-omb-cloud-power";
const answer = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });

describe("the Cloud's asleep answer to a held poll", () => {
  it("is read under the old name and under the new name", () => {
    expect(cloudAsleepAnswer(answer(503, { [OLD]: "asleep" }))).toBe(true);
    expect(cloudAsleepAnswer(answer(503, { "x-seira-cloud-power": "asleep" }))).toBe(true);
  });

  it("needs a 503 and the word asleep", () => {
    expect(cloudAsleepAnswer(answer(503))).toBe(false);
    expect(cloudAsleepAnswer(answer(503, { "x-seira-cloud-power": "awake" }))).toBe(false);
    expect(cloudAsleepAnswer(answer(200, { "x-seira-cloud-power": "asleep" }))).toBe(false);
    expect(cloudAsleepAnswer(answer(502, { [OLD]: "asleep" }))).toBe(false);
  });

  it("takes the new name when both are present", () => {
    expect(cloudAsleepAnswer(answer(503, { "x-seira-cloud-power": "awake", [OLD]: "asleep" }))).toBe(false);
    expect(cloudAsleepAnswer(answer(503, { "x-seira-cloud-power": "asleep", [OLD]: "awake" }))).toBe(true);
  });
});
