import { describe, expect, it } from "vitest";
import { mentionPicksFor } from "./mention-picks";

describe("mention picks", () => {
  it("keeps a picked bot and leaves a picked tool out", () => {
    const picks = mentionPicksFor("draft-tools");
    picks.pick({ id: "bot-1", name: "Quill", bot: {} });
    picks.pick({ id: "tool:app:gmail", name: "Gmail" });
    expect(picks.ids("@Quill and @Gmail")).toEqual(["bot-1"]);
    picks.clear();
  });
});
