import { describe, expect, it } from "vitest";

import { PERSON_TOOL_DEFINITIONS } from "./agents-person-tools.ts";

describe("message_person", () => {
  it("tells the bot to ask with buttons for a decision, an approval, or a step only the person can take", () => {
    const [tool] = PERSON_TOOL_DEFINITIONS;
    expect(tool!.name).toBe("message_person");
    expect(tool!.description).toContain("For a decision, approval, or action, ask with buttons instead.");
  });
});
