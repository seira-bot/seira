import { describe, expect, it, vi } from "vitest";

vi.mock("./bot-box/box.ts", () => ({
  botBox: { boxesBot: vi.fn(() => false) },
}));

import { botBox } from "./bot-box/box.ts";
import {
  containerComputerMcp,
  LOCAL_VM_IN_BOX_MESSAGE,
  localVmInBoxMessage,
} from "./local-vm-box.ts";

describe("Local VM inside the bot box", () => {
  it("names the Docker socket limit when the box is on", () => {
    expect(localVmInBoxMessage(true)).toBe(LOCAL_VM_IN_BOX_MESSAGE);
    expect(LOCAL_VM_IN_BOX_MESSAGE).toContain("Docker socket");
    expect(LOCAL_VM_IN_BOX_MESSAGE).toContain("bot box");
  });

  it("allows the mount message when the box is off", () => {
    expect(localVmInBoxMessage(false)).toBeUndefined();
  });

  it("refuses containerComputerMcp for a bot whose spawns run in the bot box", () => {
    vi.mocked(botBox.boxesBot).mockImplementation((botId) => botId === "limited");
    expect(() => containerComputerMcp("docker", undefined, undefined, "limited")).toThrow(LOCAL_VM_IN_BOX_MESSAGE);
    expect(containerComputerMcp("docker", undefined, undefined, "open").command).toBe(process.execPath);
  });

  it("mounts normally while the bot box is off", () => {
    vi.mocked(botBox.boxesBot).mockReturnValue(false);
    const connection = containerComputerMcp("podman");
    expect(connection.command).toBe(process.execPath);
    expect(connection.args).toContain("podman");
  });
});
