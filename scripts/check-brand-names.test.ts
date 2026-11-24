import { describe, expect, it } from "vitest";

import { ATTRIBUTION_PATHS, compare, findMatches, lowerBaseline, OLD_NAME, withoutKept } from "./check-brand-names.mjs";

const find = (files: Record<string, string>) => findMatches(Object.keys(files), (path: string) => files[path]);

describe("old upstream names", () => {
  it("matches the old names and not ordinary words", () => {
    for (const line of ["OMB_HOME=1", "x-omb-signature", "omb_pd_abc", "omb.1", "OpenMausBot", "MausBot", "milind-soni/x", "omb-sync"]) {
      expect(OLD_NAME.test(line), line).toBe(true);
    }
    for (const line of ["bomb", "combo", "tomb", "Omber", "seira"]) {
      expect(OLD_NAME.test(line), line).toBe(false);
    }
  });

  it("skips attribution files", () => {
    expect([...ATTRIBUTION_PATHS]).toContain("NOTICE");
    expect(find({ NOTICE: "OpenMausBot", "b.ts": "clean" })).toEqual({});
  });

  it("does not count an allowed token alone on a line", () => {
    const text = [
      'const SUFFIX = ".ombbackup";',
      "see https://github.com/milind-soni/OpenMausBot/pull/2547",
      "fixed in milind-soni/OpenMausBot#2547",
      'const v = request.headers.get("x-omb-poller");',
    ].join("\n");
    expect(find({ "f.ts": text })).toEqual({});
  });

  it("still checks the rest of a line that holds an allowed token", () => {
    const lines = [
      'const a = ".ombbackup"; const label = "OpenMausBot";',
      'const h = request.headers.get("x-omb-poller"); send({ "x-omb-cloud-power": "asleep" });',
      "see https://github.com/milind-soni/OpenMausBot/pull/2547 and milind-soni/OpenMausBot/releases/x",
      'headers.get("x-omb-a") ?? headers.get("x-omb-b") + "omb_pd_"',
    ];
    for (const line of lines) {
      expect(withoutKept(line), line).toMatch(OLD_NAME);
      expect(Object.keys(find({ "f.ts": line })), line).toEqual(["f.ts"]);
    }
  });

  it("fails a replacement at the same count", () => {
    const baseline = { "a.ts": ['const x = "omb.1";', 'const y = "OMB_HOME";'] };
    const swapped = find({ "a.ts": 'const x = "omb.1";\nconst y = "omb_new";' });
    expect(Object.values(swapped)[0]).toHaveLength(2);
    expect(compare(swapped, baseline)).toEqual([{ path: "a.ts", line: 'const y = "omb_new";', found: 1, allowed: 0 }]);
  });

  it("fails a new path, a rise in repeats, and passes the same or fewer", () => {
    expect(compare({ "new.ts": ["omb"] }, {})).toHaveLength(1);
    expect(compare({ "a.ts": ["omb", "omb"] }, { "a.ts": ["omb"] })).toEqual([{ path: "a.ts", line: "omb", found: 2, allowed: 1 }]);
    expect(compare({ "a.ts": ["omb"] }, { "a.ts": ["omb"] })).toEqual([]);
    expect(compare({ "a.ts": ["omb"] }, { "a.ts": ["omb", "omb"] })).toEqual([]);
  });

  it("--update only lowers: it drops gone entries and never adds a path, a line or a repeat", () => {
    const baseline = { "a.ts": ["omb", "omb", "OMB_X"], "gone.ts": ["omb"] };
    const found = { "a.ts": ["omb", "OMB_NEW"], "new.ts": ["omb"] };
    expect(lowerBaseline(found, baseline)).toEqual({ "a.ts": ["omb"] });
    expect(lowerBaseline({ "a.ts": ["omb", "omb", "omb"] }, { "a.ts": ["omb"] })).toEqual({ "a.ts": ["omb"] });
  });
});
