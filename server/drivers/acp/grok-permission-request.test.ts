import { describe, expect, it } from "vitest";
import { grokPermissionRequest } from "./grok.ts";

const BASH_OPTIONS = [
  { optionId: "always-allow", name: "Yes, and don't ask again for bash commands", kind: "allow_always" },
  { optionId: "allow-once", name: "Yes, proceed", kind: "allow_once" },
  { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
  { optionId: "reject-always", name: "No, and don't ask again for this command", kind: "reject_always" },
];
const EDIT_OPTIONS = [
  { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
];

describe("Grok's \"allow for this session\" stays scoped to the session", () => {
  it("drops every allow_always option except the session-scoped one", () => {
    const filtered = (options: object[]) =>
      grokPermissionRequest({ toolCall: { toolCallId: "call-1" }, options }).options.map((option: { optionId: string }) => option.optionId);
    expect(filtered(BASH_OPTIONS)).toEqual(["allow-once", "reject-once", "reject-always"]);
    expect(filtered(EDIT_OPTIONS)).toEqual(["allow-edits-session", "allow-once", "reject-once"]);
    expect(filtered([{ optionId: "enable-always-approve", kind: "allow_always" }, { optionId: "allow-once", kind: "allow_once" }]))
      .toEqual(["allow-once"]);
  });

  it("leaves an ask_user_question interaction untouched", () => {
    const question = { toolCall: { toolCallId: "interaction_1" }, options: [{ optionId: "a", kind: "allow_always", name: "A" }] };
    expect(grokPermissionRequest(question)).toBe(question);
  });
});
