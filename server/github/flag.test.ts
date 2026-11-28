import { describe, expect, it } from "vitest";

import { githubAppEnabled } from "./flag.ts";

describe("githubAppEnabled", () => {
  it("is on by default and off only when the config says false", () => {
    expect(githubAppEnabled({}, {})).toBe(true);
    expect(githubAppEnabled({ features: {} }, {})).toBe(true);
    expect(githubAppEnabled({ features: { githubApp: true } }, {})).toBe(true);
    expect(githubAppEnabled({ features: { githubApp: false } }, {})).toBe(false);
  });

  it("lets SEIRA_GITHUB_APP win over the config", () => {
    expect(githubAppEnabled({ features: { githubApp: false } }, { SEIRA_GITHUB_APP: "1" })).toBe(true);
    expect(githubAppEnabled({ features: { githubApp: true } }, { SEIRA_GITHUB_APP: "0" })).toBe(false);
  });
});
