import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { approvalModeFor } from "../shared/approval-mode.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { newBotApproval, newBotDefaultsSchema } from "./new-bot-defaults.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function setupCreating(store: Store, requestId: string): TeamSetupRequest {
  const chief = store.createBot({ name: "Chief", section: "Ops" });
  store.patchBot(chief.id, { chiefOfStaff: true });
  return { version: 1, requestId, botId: chief.id, threadId: chief.threadId,
    reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
      { action: "create", botId: `specialist-${requestId}`, threadId: `specialist-thread-${requestId}`,
        fields: { name: "Specialist", section: "Ops", modelSelection: selection() } },
    ] };
}

describe("a bot a Chief's team setup creates starts at the saved New bot level", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it.each(["ask", "auto", "full"] as const)("starts at %s when that level is passed in", (level) => {
    const store = new Store(selection);
    store.applyTeamSetup(setupCreating(store, `setup-${level}`), level);
    expect(approvalModeFor(store.bot(`specialist-setup-${level}`)!)).toBe(level);
  });

  it("keeps the workspace default when no level is passed in", () => {
    const store = new Store(selection);
    store.applyTeamSetup(setupCreating(store, "setup-none"));
    const bot = store.bot("specialist-setup-none")!;
    expect(bot.approvalMode).toBeUndefined();
    expect(bot.autoApprove).toBe(false);
  });

  it("reads the saved New bot default the way the New bot dialog does", () => {
    const saved = (approvalMode: string) => newBotDefaultsSchema.parse({ profile: { approvalMode } });
    expect(newBotApproval(saved("ask"), false)).toBe("ask");
    expect(newBotApproval(saved("auto"), false)).toBe("auto");
    expect(newBotApproval(saved("full"), false)).toBe("full");
    expect(newBotApproval(saved("full"), true)).toBeUndefined();
    expect(newBotApproval(saved("custom"), false)).toBe("ask");
    expect(newBotApproval(undefined, false)).toBeUndefined();
    expect(newBotApproval(newBotDefaultsSchema.parse({}), false)).toBeUndefined();
  });
});
