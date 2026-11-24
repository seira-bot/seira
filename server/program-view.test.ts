// Where an engine looks up a program by name must be where it runs it: the bot box's PATH and files, the host a Flatpak
// launches from, or this computer. A name is never looked up in one place and run from another.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { botBox } from "./bot-box/box.ts";
import type { BoxPlan } from "./bot-box/plan.ts";
import { resetPathCacheForTests } from "./env-path.ts";
import { setHostRunnerForTests, type HostRunner } from "./flatpak-host.ts";
import { programViewFor } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const program = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\n");
  chmodSync(join(dir, name), 0o755);
  return join(dir, name);
};

describe.skipIf(process.platform === "win32")("the place a program is looked up", () => {
  let root: string;
  const startDir = process.cwd();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seira-program-view-"));
    resetPathCacheForTests();
  });
  afterEach(async () => {
    process.chdir(startDir);
    delete process.env.FLATPAK_ID;
    vi.restoreAllMocks();
    setHostRunnerForTests(null);
    resetPathCacheForTests();
    await removeTempDir(root);
  });

  describe("on this computer", () => {
    it("takes the first runnable file on PATH and never searches an empty or relative entry", () => {
      const first = program(join(root, "a"), "mcp-tool");
      process.chdir(root);
      program(join(root, "rel"), "relative-tool");
      const view = programViewFor("dsh", { env: { PATH: ["", "rel", join(root, "none"), join(root, "a")].join(delimiter) } });
      expect(view?.find("mcp-tool")).toBe(first);
      expect(view?.find("relative-tool")).toBeUndefined();
    });
  });

  describe("in the bot box", () => {
    const boxPlan = (tools: string): BoxPlan => ({
      mounts: [
        { kind: "ro", source: "/usr", target: "/usr" },
        { kind: "symlink", link: "/bin", target: "usr/bin" },
        { kind: "ro", source: tools, target: tools },
        { kind: "tmpfs", target: "/scratch" },
      ],
    }) as unknown as BoxPlan;

    it("finds a command that only the box's PATH names, and not one the box does not show", () => {
      const inBox = program(join(root, "box-tools"), "box-only-tool");
      program(join(root, "host-tools"), "host-only-tool");
      vi.spyOn(botBox, "takes").mockReturnValue(true);
      vi.spyOn(botBox, "view").mockReturnValue({ plan: boxPlan(join(root, "box-tools")), path: `/usr/bin:${join(root, "box-tools")}` });
      // The server's own PATH has the host-only folder; the box's PATH has its own.
      const view = programViewFor("dsh", { cwd: root, env: { PATH: `/usr/bin:${join(root, "host-tools")}` } });
      expect(view?.find("box-only-tool")).toBe(inBox);
      expect(view?.find("host-only-tool")).toBeUndefined();
    });

    it("does not take a program in a folder the box has hidden", () => {
      program(join(root, "box-tools"), "hidden-tool");
      vi.spyOn(botBox, "takes").mockReturnValue(true);
      vi.spyOn(botBox, "view").mockReturnValue({
        plan: { mounts: [{ kind: "ro", source: join(root, "box-tools"), target: join(root, "box-tools") }, { kind: "tmpfs", target: join(root, "box-tools") }] } as unknown as BoxPlan,
        path: join(root, "box-tools"),
      });
      expect(programViewFor("dsh", { cwd: root, env: {} })?.find("hidden-tool")).toBeUndefined();
    });

    it("gives no view when the box does not take the spawn after all", () => {
      vi.spyOn(botBox, "takes").mockReturnValue(true);
      vi.spyOn(botBox, "view").mockReturnValue(null);
      expect(programViewFor("dsh", { cwd: root, env: {} })).toBeNull();
    });
  });

  describe("in a Flatpak", () => {
    const hostOnly = "/opt/host/bin/host-only-tool";
    let searched: string[] = [];
    const host: HostRunner = (argv) => {
      if (argv[1] === "printenv") return { status: 0, stdout: "/usr/bin\n" };
      if (argv[1] === "/bin/sh") {
        searched = String(argv[5]).split(":");
        return argv.at(-1) === "host-only-tool" ? { status: 0, stdout: `${hostOnly}\0${hostOnly}\0` } : { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    };
    beforeEach(() => {
      process.env.FLATPAK_ID = "bot.seira.Seira";
      searched = [];
      setHostRunnerForTests(host);
      vi.spyOn(botBox, "takes").mockReturnValue(false);
    });

    it("finds a program that exists only on the host, which this sandbox cannot stat", () => {
      const view = programViewFor("dsh", { env: { PATH: "/usr/bin:/opt/host/bin" } });
      expect(view?.find("host-only-tool")).toBe(hostOnly);
      expect(view?.find("absent-tool")).toBeUndefined();
    });

    it("hands the host only whole folders: no empty or relative entry", () => {
      programViewFor("dsh", { env: { PATH: [":", "", "rel/bin", "/usr/bin", "./x"].join(":") } })?.find("host-only-tool");
      expect(searched).toEqual(["/usr/bin"]);
    });

    it("gives no view for an engine that runs inside the sandbox", () => {
      expect(programViewFor("/app/bin/engine", { env: { PATH: "/usr/bin" } })).toBeNull();
    });

    it("gives no view when the box would take the spawn, which a Flatpak refuses to launch", () => {
      vi.spyOn(botBox, "takes").mockReturnValue(true);
      expect(programViewFor("dsh", { env: { PATH: "/usr/bin" } })).toBeNull();
    });
  });
});
