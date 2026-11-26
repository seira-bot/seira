import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { NewBotApproval } from "../new-bot-defaults.ts";
import { Store } from "../store.ts";
import { createStorePorts } from "./ports.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function ports(store: Store, newBotApproval?: () => NewBotApproval | undefined) {
  return createStorePorts(store, {
    ...(newBotApproval ? { newBotApproval } : {}),
    mcp: { servers: () => ({}), refusal: () => null, persist: () => {} },
    routines: { create: () => ({ id: "routine" }), get: () => null, update: () => null, remove: () => null },
  });
}

describe("a bot an AI import creates starts at the saved New bot level", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it.each(["ask", "full"] as const)("starts at %s when that level is passed in", (level) => {
    const store = new Store(selection);
    const bot = store.bot(ports(store, () => level).bots.create("Imported"))!;
    expect(approvalModeFor(bot)).toBe(level);
    expect(bot.autoApprove).toBe(false);
  });

  it("keeps the workspace default when no level is passed in", () => {
    const store = new Store(selection);
    const bot = store.bot(ports(store).bots.create("Imported"))!;
    expect(bot.approvalMode).toBeUndefined();
    expect(bot.autoApprove).toBeUndefined();
  });

  it("reads the saved level again for each bot it creates", () => {
    const store = new Store(selection);
    let level: NewBotApproval | undefined = "ask";
    const created = ports(store, () => level);
    const first = created.bots.create("First");
    level = undefined;
    const second = created.bots.create("Second");
    expect(store.bot(first)!.approvalMode).toBe("ask");
    expect(store.bot(second)!.approvalMode).toBeUndefined();
  });
});
