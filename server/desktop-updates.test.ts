import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  LEGACY_IMAGE,
  TARGET_LABEL,
  WORKSPACE_LABEL,
  containerComputerAction,
  containerComputerStatus,
  localVmContainerName,
  perBotLocalVmTarget,
  type CommandRunner,
  type ContainerComputerStatus,
  type LocalVmTarget,
} from "./container-computer.ts";
import { createLocalVmUpdater, localVmUpdateNeed, vpsDesktopOutdated } from "./desktop-updates.ts";

const status = (over: Partial<ContainerComputerStatus>) => ({
  runtime: "docker", daemonUp: true, image: true, imageMatches: true, managed: true, container: "running",
  create_supported: true, ready: false, problem: null, ...over,
}) as ContainerComputerStatus;

describe("localVmUpdateNeed", () => {
  it("names the old desktops this release must update, and only those", () => {
    expect(localVmUpdateNeed(status({ imageMatches: false }), true)).toBe("recreate");
    expect(localVmUpdateNeed(status({ imageMatches: false, image: false }), false)).toBe("image");
    expect(localVmUpdateNeed(status({ container: "missing", image: false, imageMatches: false }), true)).toBe("image");
    // Nothing to update: a current desktop, a person who never used the VM, a container Seira did not make, no runtime.
    expect(localVmUpdateNeed(status({}), true)).toBeNull();
    expect(localVmUpdateNeed(status({ container: "missing", image: false, imageMatches: false }), false)).toBeNull();
    expect(localVmUpdateNeed(status({ managed: false, imageMatches: false }), true)).toBeNull();
    expect(localVmUpdateNeed(status({ daemonUp: false, imageMatches: false }), true)).toBeNull();
  });
});

describe("vpsDesktopOutdated", () => {
  it("is true only for this bot's own VPS container on an image this release no longer runs", () => {
    const old = { configured: true, daemonUp: true, container: "running", managed: true, imageMatches: false };
    expect(vpsDesktopOutdated(old)).toBe(true);
    expect(vpsDesktopOutdated({ ...old, imageMatches: true })).toBe(false);
    expect(vpsDesktopOutdated({ ...old, container: "missing" })).toBe(false);
    expect(vpsDesktopOutdated({ ...old, managed: false })).toBe(false);
    expect(vpsDesktopOutdated({ ...old, daemonUp: false })).toBe(false);
    expect(vpsDesktopOutdated(null)).toBe(false);
  });
});

describe("createLocalVmUpdater", () => {
  const target: LocalVmTarget = { key: "bot:abc", containerName: "seira-computer-abc", legacyContainerName: "openmausbot-computer-abc", workspaceDir: "/nonexistent", viewerPort: null, label: "abc" };
  const setup = (opts: { held?: () => boolean } = {}) => {
    let current = status({ imageMatches: false, image: false });
    const calls: string[] = [];
    let imageBusy = false;
    let provisionBusy = false;
    const lifecycleBusy = new Set<string>();
    const updater = createLocalVmUpdater({
      status: async () => current,
      act: async (action) => {
        calls.push(action);
        if (action === "pull") current = { ...current, image: true };
        if (action === "stop") current = { ...current, container: "stopped" };
        if (action === "remove") current = { ...current, container: "missing" };
        if (action === "run") current = { ...current, container: "running", imageMatches: true };
        return current;
      },
      keepSignIns: async () => { calls.push(`keep (lifecycle busy: ${lifecycleBusy.has(target.key)}, provision busy: ${provisionBusy})`); return "rescued"; },
      keepApps: async () => "none",
      imageBusy: { get: () => imageBusy, set: (busy) => { imageBusy = busy; } },
      provisionBusy: { get: () => provisionBusy, set: (busy) => { provisionBusy = busy; } },
      lifecycleBusy,
      inUse: () => opts.held?.() ?? false,
      updated: () => { calls.push("updated"); },
      workspaceExists: () => true,
      pollMs: 5,
    });
    return { updater, calls, lifecycle: lifecycleBusy, now: () => current };
  };

  it("builds the image, keeps the sign-ins inside the update's own fence, then remakes the desktop", async () => {
    const { updater, calls, lifecycle } = setup();
    expect(updater.observe(target, status({ imageMatches: false, image: false }))).toBe(true);
    await updater.sweep();
    expect(calls).toEqual(["pull", "keep (lifecycle busy: true, provision busy: true)", "remove", "run", "updated"]);
    expect(lifecycle.size).toBe(0);
    expect(updater.pending(target)).toBe(false);
  });

  it("waits while a turn holds the desktop, and starts the moment it is free", async () => {
    let held = true;
    const { updater, calls } = setup({ held: () => held });
    updater.observe(target, status({ imageMatches: false, image: false }));
    const running = updater.sweep();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toEqual(["pull"]);
    held = false;
    await running;
    expect(calls.at(-1)).toBe("updated");
  });

  it("tells a waiting turn plainly, and lets it stop", async () => {
    let held = true;
    const { updater } = setup({ held: () => held });
    updater.observe(target, status({ imageMatches: false, image: false }));
    const announced: string[] = [];
    let current = true;
    const waiting = updater.waitFor(target, { isCurrent: () => current, cancelled: () => new Error("stopped"), announce: (text) => announced.push(text) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    current = false;
    await expect(waiting).rejects.toThrow("stopped");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatch(/^Updating this bot's desktop to the new version/);
    held = false;
  });
});

describe("updating a desktop that still has the older name", () => {
  it("keeps sign-ins and apps from the older container, removes it by that name, and creates the new one", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seira-legacy-update-"));
    const target = { ...perBotLocalVmTarget("legacy-update"), workspaceDir: workspace };
    const labels = { [MANAGED_LABEL]: "1", [DRIVER_LABEL]: CUA_DRIVER_VERSION, [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST, [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION };
    const imageInspect = JSON.stringify([{ Id: "sha256:current-build", Config: { Labels: labels } }]);
    let present: "older" | "none" | "new" = "older";
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (key === "/usr/bin/which docker") return { stdout: "docker" };
      if (command === "/usr/bin/which") throw new Error("missing executable");
      if (args[0] === "info") return { stdout: "29" };
      if (key === `docker image inspect ${IMAGE}`) return { stdout: imageInspect };
      if (key === `docker inspect ${target.legacyContainerName}` && present === "older") {
        return { stdout: JSON.stringify([{ Config: { Image: LEGACY_IMAGE, Labels: { ...labels, [WORKSPACE_LABEL]: "1", [TARGET_LABEL]: target.label } }, State: { Running: false }, Image: "sha256:old-build" }]) };
      }
      if (key === `docker inspect ${target.containerName}` && present === "new") {
        return { stdout: JSON.stringify([{ Config: { Image: IMAGE, Labels: { ...labels, [WORKSPACE_LABEL]: "1", [TARGET_LABEL]: target.label } }, State: { Running: true }, Image: "sha256:current-build" }]) };
      }
      if (args[0] === "inspect") throw new Error("missing container");
      if (key === `docker rm -f ${target.legacyContainerName}`) { present = "none"; return { stdout: "" }; }
      if (args[0] === "run") { present = "new"; return { stdout: "id" }; }
      throw new Error(`unexpected command: ${key}`);
    };
    const kept: string[] = [];
    const updater = createLocalVmUpdater({
      status: (t) => containerComputerStatus(run, "linux", t),
      act: (action, t) => containerComputerAction(action, run, "linux", t),
      keepSignIns: async (t) => { kept.push(`sign-ins ${localVmContainerName(t)}`); return "rescued"; },
      keepApps: async (t) => { kept.push(`apps ${localVmContainerName(t)}`); return "rescued"; },
      imageBusy: { get: () => false, set: () => {} },
      provisionBusy: { get: () => false, set: () => {} },
      lifecycleBusy: new Set<string>(),
      inUse: () => false,
      updated: () => {},
      workspaceExists: () => true,
      pollMs: 5,
    });
    try {
      expect(updater.observe(target, await containerComputerStatus(run, "linux", target))).toBe(true);
      await updater.sweep();
      expect(kept).toEqual([`sign-ins ${target.legacyContainerName}`, `apps ${target.legacyContainerName}`]);
      expect(calls).toContain(`docker rm -f ${target.legacyContainerName}`);
      const runCall = calls.find((call) => call.startsWith("docker run "));
      expect(runCall).toContain(`--name ${target.containerName} `);
      expect(calls.indexOf(`docker rm -f ${target.legacyContainerName}`)).toBeLessThan(calls.indexOf(runCall!));
      expect(localVmContainerName(target)).toBe(target.containerName);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
