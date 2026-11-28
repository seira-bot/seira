import { describe, expect, it } from "vitest";

import { layLanes } from "./model";
import { slotChoices } from "./phrases";

describe("layLanes", () => {
  it("puts overlapping items side by side and lets a later item reuse the first lane", () => {
    const lanes = layLanes([{ top: 0, height: 36 }, { top: 20, height: 36 }, { top: 100, height: 36 }]);
    expect(lanes).toEqual([{ lane: 0, lanes: 2 }, { lane: 1, lanes: 2 }, { lane: 0, lanes: 1 }]);
  });
});

describe("slotChoices", () => {
  it("names once, every week on that day and every day, each with a phrase", () => {
    const choices = slotChoices(new Date(2026, 11, 1, 10, 0).getTime());
    expect(choices.map((choice) => choice.id)).toEqual(["once", "weekly", "daily"]);
    expect(choices[1]).toMatchObject({ label: "Every Tuesday at 10:00", phrase: "every Tuesday at 10:00" });
    expect(choices[2]).toMatchObject({ label: "Every day at 10:00", phrase: "every day at 10:00" });
  });
});
