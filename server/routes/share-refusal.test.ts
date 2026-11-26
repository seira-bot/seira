import { describe, expect, it, vi } from "vitest";

import { PackageFormatError } from "../../shared/package-format.ts";
import { GENERIC_PUBLIC_ERROR, inheritingPublicDecision, withheld } from "../public-error.ts";
import { ShareError } from "../share.ts";
import { GithubTemplateError } from "../share-github.ts";
import { TeamExportError } from "../package-export.ts";
import { refusal } from "./share.ts";

describe("the words of a share refusal", () => {
  it("keeps the message and the status of a refusal that is public", () => {
    expect(refusal(new ShareError("This template is already added.", 409))).toEqual({ status: 409, error: "This template is already added." });
    expect(refusal(new GithubTemplateError("This link is not a template.", 404))).toEqual({ status: 404, error: "This link is not a template." });
  });

  it("keeps the format's own sentence and its status", () => {
    expect(refusal(new PackageFormatError("too_large", "This package is too large."))).toEqual({ status: 413, error: "This package is too large." });
  });

  it("gives the generic text, with the status, for a refusal that was withheld", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outside = withheld(new ShareError("could not read /srv/data/private.json", 400));
      expect(refusal(outside)).toEqual({ status: 400, error: GENERIC_PUBLIC_ERROR });
      expect(String(logged.mock.calls[0]![0])).toContain("private.json");
    } finally { logged.mockRestore(); }
  });

  it("does not make a withheld export error public when it becomes a share error", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outside = withheld(new TeamExportError("could not read /srv/data/private.json"));
      const wrapped = inheritingPublicDecision(outside, new ShareError(outside.message, outside.status));
      expect(refusal(wrapped)).toEqual({ status: 400, error: GENERIC_PUBLIC_ERROR });
      const own = new TeamExportError("This department has no bots.");
      expect(refusal(inheritingPublicDecision(own, new ShareError(own.message, own.status)))).toEqual({ status: 400, error: "This department has no bots." });
    } finally { logged.mockRestore(); }
  });

  it("leaves an error that is not a refusal to the caller", () => {
    expect(refusal(new Error("boom"))).toBeNull();
  });
});
