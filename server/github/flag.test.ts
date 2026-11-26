import { describe, expect, it } from "vitest";

import { githubAppEnabled } from "./flag.ts";

describe("githubAppEnabled", () => {
  it("is off by default and on only when the config says true", () => {
    expect(githubAppEnabled({}, {})).toBe(false);
    expect(githubAppEnabled({ features: { githubApp: false } }, {})).toBe(false);
    expect(githubAppEnabled({ features: { githubApp: true } }, {})).toBe(true);
  });

  it("lets SEIRA_GITHUB_APP win over the config", () => {
    expect(githubAppEnabled({}, { SEIRA_GITHUB_APP: "1" })).toBe(true);
    expect(githubAppEnabled({ features: { githubApp: true } }, { SEIRA_GITHUB_APP: "0" })).toBe(false);
  });
});
