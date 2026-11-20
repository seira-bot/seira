import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/seira/.seira", "darwin", "/Users/seira", {})).toBe("/Users/seira/Library/Application Support/seira-sentinel");
    expect(defaultSentinelOut("/home/seira/.seira", "linux", "/home/seira", {})).toBe("/home/seira/.local/state/seira-sentinel");
    expect(defaultSentinelOut("/home/seira/.seira", "linux", "/home/seira", { XDG_STATE_HOME: "/var/state/seira" })).toBe("/var/state/seira/seira-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/seira/.seira", "linux", "/home/seira", { XDG_STATE_HOME: "state" })).toBe("/home/seira/.local/state/seira-sentinel");
    expect(defaultSentinelOut("C:\\Users\\seira\\.seira", "win32", "C:\\Users\\seira", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\seira-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/seira-data", "linux", "/home/seira", {});
    expect(other).toMatch(/^\/home\/seira\/\.local\/state\/seira-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/seira-data", "linux", "/home/seira", {})).toBe(other);
    expect(defaultSentinelOut("/srv/seira-data-2", "linux", "/home/seira", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/seira/sentinel", "/d/seira", "linux")).toBe(true);
    expect(isInside("/d/seira", "/d/seira", "linux")).toBe(true);
    expect(isInside("/d/seira-sentinel", "/d/seira", "linux")).toBe(false);
    expect(isInside("/d", "/d/seira", "linux")).toBe(false);
    expect(isInside("C:\\d\\seira\\x", "C:\\d\\seira", "win32")).toBe(true);
  });
});
