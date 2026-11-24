import { describe, expect, it } from "vitest";

import { ATTRIBUTION_PATHS, compare, countMatches, lowered, OLD_NAME } from "./check-brand-names.mjs";

describe("old upstream names", () => {
  it("matches the old names and not ordinary words", () => {
    for (const line of ["OMB_HOME=1", "x-omb-signature", "omb_pd_abc", "omb.1", "OpenMausBot", "MausBot", "milind-soni/x", "omb-sync"]) {
      expect(OLD_NAME.test(line), line).toBe(true);
    }
    for (const line of ["bomb", "combo", "tomb", "Omber", "seira"]) {
      expect(OLD_NAME.test(line), line).toBe(false);
    }
  });

  it("skips attribution files and counts matching lines", () => {
    const files: Record<string, string> = { NOTICE: "OpenMausBot", "a.ts": "omb\nok\nOMB_X", "b.ts": "clean" };
    expect([...ATTRIBUTION_PATHS]).toContain("NOTICE");
    expect(countMatches(Object.keys(files), (p: string) => files[p])).toEqual({ "a.ts": 2 });
  });

  it("fails a new file and a rise, passes the same or a lower count", () => {
    expect(compare({ "new.ts": 1 }, {})).toEqual([{ path: "new.ts", found: 1, allowed: 0 }]);
    expect(compare({ "a.ts": 3 }, { "a.ts": 2 })).toEqual([{ path: "a.ts", found: 3, allowed: 2 }]);
    expect(compare({ "a.ts": 2 }, { "a.ts": 2 })).toEqual([]);
    expect(compare({ "a.ts": 1 }, { "a.ts": 2 })).toEqual([]);
    expect(lowered({ "a.ts": 1 }, { "a.ts": 2, "gone.ts": 1 })).toEqual(["a.ts", "gone.ts"]);
  });
});
