import { describe, expect, it, vi } from "vitest";
import { placeConfirmed, placeLostAs, PLACE_LOST_MESSAGE } from "./place-lost.ts";
import { GENERIC_PUBLIC_ERROR, isPublicError, PublicError, publicErrorMessage, publicErrorText } from "./public-error.ts";
import { userErrorThrown } from "./user-errors.ts";
import { WebhookRequestError } from "./webhook-requests.ts";

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

describe("publicErrorText", () => {
  it("gives the generic text for an unknown error, and logs the full error with secrets removed", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const internal = new Error("ENOENT: no such file /home/ada/.seira/config.json, token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
      const text = publicErrorText(internal, "GET /api/example");
      expect(text).toBe(GENERIC_PUBLIC_ERROR);
      expect(text).not.toContain("ENOENT");
      expect(text).not.toContain("/home/ada");
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0]![0]);
      expect(line).toContain("GET /api/example");
      expect(line).toContain("ENOENT");
      expect(line).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    } finally { logged.mockRestore(); }
  });

  it("gives the fallback for a value that is not an Error, and for a 5xx status", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(publicErrorText("/srv/private/path.ts:12", "x", "Not run.")).toBe("Not run.");
      expect(publicErrorText(Object.assign(new Error("upstream said: internal host db-7"), { status: 502 }), "x")).toBe(GENERIC_PUBLIC_ERROR);
    } finally { logged.mockRestore(); }
  });

  it("keeps the message of a known error, and its 409, when a refused place passes through placeLostAs", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let caught: unknown;
      try { placeLostAs(WebhookRequestError, () => placeConfirmed(true, { enabled: true })); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(WebhookRequestError);
      expect((caught as WebhookRequestError).status).toBe(409);
      expect(isPublicError(caught)).toBe(true);
      expect(publicErrorText(caught, "x")).toBe(PLACE_LOST_MESSAGE);
      expect(logged).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it("keeps the message of a PublicError, a language-pack error and a 4xx refusal", () => {
    expect(publicErrorText(new PublicError("name is required"), "x")).toBe("name is required");
    expect(publicErrorText(userErrorThrown("serverError.email.invalid"), "x")).toBe("enter a valid email address");
    expect(publicErrorText(Object.assign(new Error("unknown instance"), { status: 404 }), "x")).toBe("unknown instance");
  });
});
