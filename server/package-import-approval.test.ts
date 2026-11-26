import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { approvalModeFor } from "../shared/approval-mode.ts";
import { botAvatarUrlFromStoredPath } from "../shared/bot-avatar.ts";
import { parsePackageDocument } from "../shared/package-format.ts";
import { saveImage } from "./attachments.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import type { NewBotApproval } from "./new-bot-defaults.ts";
import { importPackageDocument, type PackageImportDeps } from "./package-import.ts";
import { RoutineManager } from "./routines.ts";
import { writeSectionContext } from "./section-context.ts";
import { installOrgSkill, installSkill, setSkillEnabled } from "./skills.ts";
import { Store } from "./store.ts";
import { writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "default-model" });
const fullTeam = () => JSON.parse(readFileSync(join(import.meta.dirname, "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));

function importFullTeam(newBotApproval?: () => NewBotApproval | undefined, raw = fullTeam()) {
  const store = new Store(selection);
  const routines = new RoutineManager({
    file: join(DATA_DIR, "routines.json"),
    botState: (id) => (store.bot(id) && !store.bot(id)!.hidden ? "ready" : "missing"),
    goalState: (groupId, botId) => (store.group(groupId ?? "")?.memberIds.includes(botId) ? "ready" : "missing"),
    createTask: () => null,
    startTurn: async () => {},
  });
  let servers: Record<string, unknown> = {};
  const deps: PackageImportDeps = {
    store,
    routines,
    skills: { install: installSkill, setEnabled: setSkillEnabled, installOrg: installOrgSkill },
    memory: { writeIndex: writeMemoryFile, writeTopic: writeMemoryTopic },
    mcp: { servers: () => servers, refusal: () => undefined, persist: (next) => { servers = next; } },
    sections: { writeBrief: (section, text) => void writeSectionContext(section, text) },
    images: { save: (bytes, mime) => botAvatarUrlFromStoredPath(saveImage(Buffer.from(bytes), mime).path)! },
    defaultSelection: selection,
    ...(newBotApproval ? { newBotApproval } : {}),
  };
  const result = importPackageDocument(parsePackageDocument(raw), { trust: "file", mode: "add" }, deps);
  if (result.alreadyAdded) throw new Error("unexpected");
  expect(result.bots.length).toBeGreaterThan(0);
  return result.bots.map((bot) => store.bot(bot.id)!);
}

describe("a bot a team package import creates starts at the saved New bot level", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it.each(["ask", "auto", "full"] as const)("starts every imported bot at %s when that level is passed in", (level) => {
    for (const bot of importFullTeam(() => level)) {
      expect(approvalModeFor(bot)).toBe(level);
      expect(bot.autoApprove).toBe(level === "auto");
    }
  });

  it("keeps the workspace default when no level is passed in", () => {
    for (const bot of importFullTeam()) {
      expect(bot).not.toHaveProperty("approvalMode");
      expect(bot).not.toHaveProperty("autoApprove");
    }
  });

  it("never takes the level from the package, which stays a suggestion", () => {
    const raw = fullTeam();
    for (const agent of raw.package.agents) agent.approval = "auto";
    for (const bot of importFullTeam(() => "ask", raw)) {
      expect(approvalModeFor(bot)).toBe("ask");
      expect(bot.autoApprove).toBe(false);
      expect(bot.installedPackage?.suggestedApproval).toBe("auto");
    }
  });
});
