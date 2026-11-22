import { describe, expect, it } from "vitest";
import { publicErrorMessage } from "./public-error.ts";

describe("publicErrorMessage", () => {
  it("returns the message of an Error without its stack", () => {
    const text = publicErrorMessage(new Error("The call was not run."));
    expect(text).toBe("The call was not run.");
    expect(text).not.toContain(" at ");
  });

  it("answers a thrown non-Error value with the fallback", () => {
    expect(publicErrorMessage("/some/private/path.ts:12")).toBe("Something went wrong. Try again.");
    expect(publicErrorMessage({ stack: "boom" }, "Not run.")).toBe("Not run.");
    expect(publicErrorMessage(new Error(""))).toBe("Something went wrong. Try again.");
  });
});
