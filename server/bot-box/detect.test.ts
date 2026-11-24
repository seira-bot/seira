import { describe, expect, it } from "vitest";

import { boxMissingForEveryBot, boxWanted, cloudRole, detectBox } from "./detect.ts";

const tools = (found: Record<string, string>) => (name: string) => found[name] ?? null;

describe("deciding whether turns are boxed", () => {
  it("is on by default on a Cloud home, off everywhere else, and SEIRA_BOT_BOX decides either way", () => {
    expect(boxWanted({})).toBe("default");
    expect(boxWanted({ SEIRA_BOT_BOX: "0" })).toBe("off");
    expect(boxWanted({ SEIRA_BOT_BOX: "off" })).toBe("off");
    expect(boxWanted({ SEIRA_BOT_BOX: "1" })).toBe("on");
    expect(boxWanted({ SEIRA_BOT_BOX: "bwrap" })).toBe("on");
    expect(cloudRole({ SEIRA_CLOUD_ROLE: "home" })).toBe(true);
    expect(cloudRole({ SEIRA_CLOUD_ROLE: "team" })).toBe(true);
    expect(cloudRole({})).toBe(false);
    const working = { platform: "linux" as const, probe: () => true, which: tools({ bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" }) };
    expect(detectBox({ env: { SEIRA_CLOUD_ROLE: "home" }, ...working })).toEqual({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" }, scope: "all" });
    expect(detectBox({ env: { SEIRA_CLOUD_ROLE: "home", SEIRA_BOT_BOX: "0" }, ...working })).toEqual({ box: "off", reason: "switched-off", tools: null });
    expect(detectBox({ env: { SEIRA_BOT_BOX: "1" }, ...working })).toMatchObject({ box: "bwrap", scope: "all" });
  });

  it("boxes only bots limited to chosen folders on a Linux computer that is not a Cloud home", () => {
    const working = { platform: "linux" as const, probe: () => true, which: tools({ bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" }) };
    expect(detectBox({ env: {}, ...working })).toEqual({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" }, scope: "limited" });
    expect(detectBox({ env: { SEIRA_BOT_BOX: "0" }, ...working })).toEqual({ box: "off", reason: "switched-off", tools: null });
    expect(detectBox({ env: { SEIRA_BOT_BOX: "off" }, ...working })).toEqual({ box: "off", reason: "switched-off", tools: null });
    expect(detectBox({ env: {}, ...working, platform: "darwin" })).toEqual({ box: "off", reason: "not-cloud", tools: null });
    expect(detectBox({ env: {}, ...working, platform: "win32" })).toEqual({ box: "off", reason: "not-cloud", tools: null });
    expect(detectBox({ env: { FLATPAK_ID: "bot.seira.Seira" }, ...working })).toEqual({ box: "off", reason: "flatpak", tools: null });
    expect(detectBox({ env: {}, ...working, which: tools({}) })).toEqual({ box: "off", reason: "no-bwrap", tools: null });
    expect(detectBox({ env: {}, ...working, probe: () => false })).toEqual({ box: "off", reason: "userns-refused", tools: null });
  });

  it("never runs unboxed turns by surprise: no bwrap, a refusing kernel or another platform report off with the reason", () => {
    const env = { SEIRA_CLOUD_ROLE: "home" };
    expect(detectBox({ env, platform: "darwin", probe: () => true, which: tools({ bwrap: "/x" }) })).toEqual({ box: "off", reason: "not-linux", tools: null });
    expect(detectBox({ env, platform: "linux", probe: () => true, which: tools({}) })).toEqual({ box: "off", reason: "no-bwrap", tools: null });
    expect(detectBox({ env, platform: "linux", probe: () => false, which: tools({ bwrap: "/usr/bin/bwrap" }) })).toEqual({ box: "off", reason: "userns-refused", tools: null });
    expect(detectBox({ env, platform: "linux", probe: () => true, which: tools({ bwrap: "/usr/bin/bwrap" }) }).tools).toEqual({ bwrap: "/usr/bin/bwrap", socat: null });
  });

  it("reports a missing bubblewrap for the first-run notice only when every bot was meant to be boxed", () => {
    const noBwrap = (env: Record<string, string>, platform: NodeJS.Platform = "linux") => detectBox({ env, platform, probe: () => true, which: tools({}) });
    expect(boxMissingForEveryBot(noBwrap({ SEIRA_CLOUD_ROLE: "home" }), { SEIRA_CLOUD_ROLE: "home" })).toBe("no-bwrap");
    expect(boxMissingForEveryBot(noBwrap({ SEIRA_BOT_BOX: "1" }), { SEIRA_BOT_BOX: "1" })).toBe("no-bwrap");
    expect(boxMissingForEveryBot(noBwrap({}), {}), "a Linux computer that boxes only limited bots").toBeNull();
    expect(boxMissingForEveryBot(noBwrap({ SEIRA_CLOUD_ROLE: "home", SEIRA_BOT_BOX: "0" }), { SEIRA_CLOUD_ROLE: "home", SEIRA_BOT_BOX: "0" }), "switched off").toBeNull();
    expect(boxMissingForEveryBot(noBwrap({ SEIRA_CLOUD_ROLE: "home" }, "darwin"), { SEIRA_CLOUD_ROLE: "home" }), "another reason").toBeNull();
    const withBwrap = detectBox({ env: { SEIRA_CLOUD_ROLE: "home" }, platform: "linux", probe: () => true, which: tools({ bwrap: "/usr/bin/bwrap" }) });
    expect(boxMissingForEveryBot(withBwrap, { SEIRA_CLOUD_ROLE: "home" })).toBeNull();
  });
});
