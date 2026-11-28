import { expect, it } from "vitest";
import { configStatusFromFrame, type ConfigStatusFrame } from "./config-status-frame";
import { readMembership } from "./membership";

const baseFrame: ConfigStatusFrame = {
  composio: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
};

it("keeps person-paused bots and departments through a config broadcast", () => {
  const frame = { ...baseFrame, pausedByPerson: { bots: ["ada"], departments: ["Sales"] }, heldBots: ["ada", "bo"] };
  expect(configStatusFromFrame(frame)).toMatchObject({ pausedByPerson: frame.pausedByPerson, heldBots: frame.heldBots });
});

it("keeps empty pause lists after the person resumes the last bot or department", () => {
  const frame = { ...baseFrame, pausedByPerson: { bots: [], departments: [] }, heldBots: [] };
  expect(configStatusFromFrame(frame)).toMatchObject({ pausedByPerson: frame.pausedByPerson, heldBots: [] });
});

it("leaves older servers' missing pause fields absent and keeps plan pauses separate", () => {
  const config = configStatusFromFrame({ ...baseFrame, awakeLimit: 3, pausedBots: ["plan-limited"] });
  expect(config).not.toHaveProperty("pausedByPerson");
  expect(config).not.toHaveProperty("heldBots");
  expect(config).toMatchObject({ awakeLimit: 3, pausedBots: ["plan-limited"] });
});

it("keeps the AI pool through a config broadcast, so a pool a bot turned on does not show as off", () => {
  const aiPool = { enabled: true, mode: "turns" as const, members: [{ instanceId: "claude", model: "claude-sonnet-5" }, { instanceId: "codex", model: "gpt-5" }] };
  expect(configStatusFromFrame({ ...baseFrame, aiPool }).aiPool).toEqual(aiPool);
  expect(configStatusFromFrame(baseFrame)).not.toHaveProperty("aiPool");
});

it("keeps every status field a config broadcast sends, without the stream's kind and seq", () => {
  const status = {
    ...baseFrame,
    pages: { offered: false },
    botMemory: { gb: null, autoGb: 6, machineGb: 16, protection: "slice" as const, envGb: null },
    newBots: { effort: "high" as const },
    cloudStarter: true,
    waitingForRoom: true,
    planTurns: { running: 2, waiting: 1, refusedAt: 1_700_000_000_000, refused: "tasks" as const },
    routinesUnreadable: true as const,
    computerName: "Studio",
    boxMissing: "no-bwrap" as const,
  };
  const config = configStatusFromFrame({ kind: "config", seq: 42, ...status });
  expect(config).toEqual(status);
  expect(config).not.toHaveProperty("kind");
  expect(config).not.toHaveProperty("seq");
});

it("keeps a field the mapper does not name, such as membership, so a portal workspace stays a portal workspace", () => {
  const membership = { authority: "portal", pairingCodes: false, peopleUrl: "https://people.example.test/" };
  const config = configStatusFromFrame({ ...baseFrame, membership } as ConfigStatusFrame);
  expect(readMembership(config)).toEqual(membership);
});
