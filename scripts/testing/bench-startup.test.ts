import { describe, expect, it } from "vitest";

import { launchEnv, summarize } from "../bench-startup.ts";

describe("launchEnv", () => {
  const base = { PATH: "/usr/bin", LANG: "C", DISPLAY: ":1", HOME: "/real/home", SEIRA_PORT: "1", SEIRA_DATA_DIR: "/real/data", SECRET_TOKEN: "x" };
  const env = launchEnv(base, "/tmp/sandbox", "/tmp/sandbox/timeline.json");

  it("does not inherit SEIRA_ variables or unrelated variables", () => {
    expect(env.SEIRA_PORT).toBeUndefined();
    expect(env.SEIRA_DATA_DIR).toBeUndefined();
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DISPLAY).toBe(":1");
  });

  it("turns the broker off and points updates at a dead loopback origin", () => {
    expect(env.SEIRA_COMPOSIO_BROKER).toBe("off");
    expect(env.SEIRA_UPDATES_ORIGIN).toBe("http://127.0.0.1:9");
    expect(env.SEIRA_STARTUP_TIMELINE).toBe("/tmp/sandbox/timeline.json");
  });

  it("keeps every home and XDG folder inside the sandbox", () => {
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
      expect(env[key]?.startsWith("/tmp/sandbox/")).toBe(true);
    }
  });
});

describe("summarize", () => {
  it("takes the median of an odd count", () => {
    const runs = [10, 30, 20].map((ms) => ({ ok: true, marks: { shown: ms } }));
    expect(summarize(runs).shown).toEqual({ median: 20, min: 10, max: 30, runs: 3 });
  });

  it("averages the middle pair of an even count", () => {
    const runs = [10, 20, 30, 40].map((ms) => ({ ok: true, marks: { shown: ms } }));
    expect(summarize(runs).shown.median).toBe(25);
  });

  it("skips failed runs and counts only the runs that have a mark", () => {
    const runs = [
      { ok: true, marks: { a: 1, b: 100 } },
      { ok: true, marks: { a: 3 } },
      { ok: false, error: "timeout" },
    ];
    const summary = summarize(runs);
    expect(summary.a).toEqual({ median: 2, min: 1, max: 3, runs: 2 });
    expect(summary.b).toEqual({ median: 100, min: 100, max: 100, runs: 1 });
  });
});
