import { describe, expect, it, vi } from "vitest";
import { placeConfirmed, placeLostAs, PLACE_LOST_MESSAGE } from "./place-lost.ts";
import { GENERIC_PUBLIC_ERROR, isPublicError, PublicError, publicErrorMessage, publicErrorText, PUBLIC_ERROR_MARK, inheritingPublicDecision, withheld } from "./public-error.ts";
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

  it("keeps the message of a PublicError and of a language-pack error", () => {
    expect(publicErrorText(new PublicError("name is required"), "x")).toBe("name is required");
    expect(publicErrorText(userErrorThrown("serverError.email.invalid"), "x")).toBe("enter a valid email address");
  });

  it("fails closed: a status, a code or an error key on a plain Error does not make it public", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(publicErrorText(Object.assign(new Error("unknown instance /srv/x"), { status: 404 }), "x")).toBe(GENERIC_PUBLIC_ERROR);
      expect(publicErrorText(Object.assign(new Error("db-7 refused"), { errorKey: "serverError.example" }), "x")).toBe(GENERIC_PUBLIC_ERROR);
      expect(isPublicError(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
    } finally { logged.mockRestore(); }
  });
});

describe("marked classes and withheld errors", () => {
  class ExampleRefusal extends Error {
    readonly [PUBLIC_ERROR_MARK] = true;
    readonly status = 409;
  }

  it("keeps the message of a class that sets the public mark, whatever its status", () => {
    expect(isPublicError(new ExampleRefusal("This name is taken."))).toBe(true);
    expect(publicErrorText(new ExampleRefusal("This name is taken."), "x")).toBe("This name is taken.");
  });

  it("gives the generic text, and logs, for an error that took back its public mark", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outside = withheld(new ExampleRefusal("remote said: host db-7 refused"));
      expect(isPublicError(outside)).toBe(false);
      expect(publicErrorText(outside, "x")).toBe(GENERIC_PUBLIC_ERROR);
      expect(String(logged.mock.calls[0]![0])).toContain("db-7");
    } finally { logged.mockRestore(); }
  });

  it("gives the fallback for a value that is not an Error, even when it has a mark", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(publicErrorText({ [PUBLIC_ERROR_MARK]: true, message: "/srv/private" }, "x", "Not run.")).toBe("Not run.");
    } finally { logged.mockRestore(); }
  });

  it("gives the generic text for a PublicError that was withheld: the explicit decision wins over the type", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outside = withheld(new PublicError("remote said: host db-7 refused", 502));
      expect(isPublicError(outside)).toBe(false);
      expect(publicErrorText(outside, "x")).toBe(GENERIC_PUBLIC_ERROR);
      expect(outside.status).toBe(502);
      expect(String(logged.mock.calls[0]![0])).toContain("db-7");
    } finally { logged.mockRestore(); }
  });

  it("keeps the decision of the source when one error wraps another", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const own = new ExampleRefusal("This name is taken.");
      const outside = withheld(new ExampleRefusal("remote said: host db-7 refused"));
      expect(isPublicError(inheritingPublicDecision(own, new ExampleRefusal(own.message)))).toBe(true);
      expect(isPublicError(inheritingPublicDecision(outside, new ExampleRefusal(outside.message)))).toBe(false);
      expect(isPublicError(inheritingPublicDecision(new Error("library text"), new PublicError("library text")))).toBe(false);
    } finally { logged.mockRestore(); }
  });
});
