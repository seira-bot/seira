import { afterEach, describe, expect, it } from "vitest";

import { botMemoryBudget, botMemoryStatusOf, currentBotBudget, defaultBotBudget, GIB, maxBotMemoryGb, useBotMemorySetting, validBotMemoryGb } from "./bot-memory-budget.ts";

describe("the default budget for bots", () => {
  it("leaves the larger of 3 GiB and a quarter of the machine to the person", () => {
    expect(defaultBotBudget(8 * GIB)).toBe(5 * GIB);
    expect(defaultBotBudget(16 * GIB)).toBe(12 * GIB);
    expect(defaultBotBudget(32 * GIB)).toBe(24 * GIB);
  });

  it("never goes below 1 GiB, or half of a machine smaller than 2 GiB", () => {
    expect(defaultBotBudget(3 * GIB)).toBe(GIB);
    expect(defaultBotBudget(1 * GIB)).toBe(GIB / 2);
  });
});

describe("the budget in force", () => {
  const total = 16 * GIB;

  it("takes the environment number over Settings, and `off` or 0 as no protection", () => {
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "2048" }, settingGb: 9, totalBytes: total })).toEqual({ bytes: 2048 * 1024 * 1024, source: "env" });
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "off" }, settingGb: 9, totalBytes: total })).toBeNull();
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "0" }, totalBytes: total })).toBeNull();
  });

  it("takes the saved number of GB, kept between 1 GB and the machine", () => {
    expect(botMemoryBudget({ env: {}, settingGb: 9, totalBytes: total })).toEqual({ bytes: 9 * GIB, source: "setting" });
    expect(botMemoryBudget({ env: {}, settingGb: 0.2, totalBytes: total })?.bytes).toBe(GIB);
    expect(botMemoryBudget({ env: {}, settingGb: 99, totalBytes: total })?.bytes).toBe(total);
  });

  it("falls back to the default for Auto or a word the environment does not know", () => {
    expect(botMemoryBudget({ env: {}, settingGb: null, totalBytes: total })).toEqual({ bytes: 12 * GIB, source: "auto" });
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "auto" }, totalBytes: total })?.source).toBe("auto");
  });

  describe("a change in Settings", () => {
    afterEach(() => useBotMemorySetting(() => undefined));

    it("shows at the next read", () => {
      let saved: number | null = null;
      useBotMemorySetting(() => saved);
      const before = currentBotBudget({})?.bytes;
      saved = 3;
      expect(currentBotBudget({})).toEqual({ bytes: 3 * GIB, source: "setting" });
      saved = null;
      expect(currentBotBudget({})?.bytes).toBe(before);
    });
  });
});

describe("a saved number of GB", () => {
  it("must be a finite number from 1 to the machine's memory", () => {
    const total = 16 * GIB;
    expect(validBotMemoryGb(1, total)).toBe(true);
    expect(validBotMemoryGb(16, total)).toBe(true);
    expect(validBotMemoryGb(0.5, total)).toBe(false);
    expect(validBotMemoryGb(17, total)).toBe(false);
    expect(validBotMemoryGb(Number.NaN, total)).toBe(false);
    expect(validBotMemoryGb("8", total)).toBe(false);
  });
});

describe("what Settings is told", () => {
  it("rounds to one decimal and names the number the environment fixes", () => {
    expect(botMemoryStatusOf({ savedGb: 7.26, env: {}, totalBytes: 16 * GIB, protection: "slice" })).toEqual({ gb: 7.3, autoGb: 12, machineGb: 16, protection: "slice", envGb: null });
    expect(botMemoryStatusOf({ savedGb: undefined, env: { SEIRA_BOT_MEMORY_MAX_MB: "4096" }, totalBytes: 8 * GIB, protection: "watchdog" })).toEqual({ gb: null, autoGb: 5, machineGb: 8, protection: "watchdog", envGb: 4 });
  });
});

describe("a machine of 15.56 GiB", () => {
  const total = Math.round(15.56 * GIB);

  it("gives Settings and the server the same largest number, floored to one decimal", () => {
    const status = botMemoryStatusOf({ savedGb: null, env: {}, totalBytes: total, protection: "slice" });
    expect(status.machineGb).toBe(15.5);
    expect(maxBotMemoryGb(total)).toBe(15.5);
    expect(validBotMemoryGb(status.machineGb, total)).toBe(true);
    expect(validBotMemoryGb(15.6, total)).toBe(false);
  });
});

describe("a number of MB in the environment below the minimum", () => {
  it("is raised to 1024 MB, with one line, and a number at the minimum is left as it is", () => {
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "100" }, totalBytes: 16 * GIB, warn })).toEqual({ bytes: GIB, source: "env" });
    expect(lines).toEqual(["SEIRA_BOT_MEMORY_MAX_MB=100 is below 1024, so 1024 MB is used"]);
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "1024" }, totalBytes: 16 * GIB, warn })?.bytes).toBe(GIB);
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "0" }, totalBytes: 16 * GIB, warn })).toBeNull();
    expect(botMemoryBudget({ env: { SEIRA_BOT_MEMORY_MAX_MB: "off" }, totalBytes: 16 * GIB, warn })).toBeNull();
    expect(lines).toHaveLength(1);
  });
});
