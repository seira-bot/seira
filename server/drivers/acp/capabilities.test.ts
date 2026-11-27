import { describe, expect, it } from "vitest";

import { acpCapabilities } from "./capabilities.ts";

describe("acpCapabilities", () => {
  it("mounts the native GitHub server on an ACP engine (AC-04)", () => {
    expect(acpCapabilities({} as Parameters<typeof acpCapabilities>[0]).githubMcp).toBe(true);
  });
});
