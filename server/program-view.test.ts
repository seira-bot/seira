// Where an engine looks up a program by name must be where it runs it: the bot box's PATH and files, the host a Flatpak
// launches from, or this computer. A name is never looked up in one place and run from another.
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { botBox } from "./bot-box/box.ts";
import { distrustHomePrograms } from "./bot-box/program-trust.ts";
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
    distrustHomePrograms(null);
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

  describe("on this computer, where the launcher trusts only some folders", () => {
    it("gives no program that a link in a trusted folder leads into a folder the bots write, and no later copy in its place", () => {
      const evil = program(join(root, "home", "bots"), "linked-tool");
      const later = program(join(root, "later"), "linked-tool");
      const good = program(join(root, "bin"), "good-tool");
      mkdirSync(join(root, "bin"), { recursive: true });
      symlinkSync(evil, join(root, "bin", "linked-tool"));
      distrustHomePrograms(join(root, "home"));
      const view = programViewFor("dsh", { env: { PATH: [join(root, "bin"), join(root, "later")].join(delimiter) } });
      expect(view?.find("good-tool")).toBe(good);
      expect(view?.find("linked-tool")).toBeUndefined();
      expect(later).toBeTruthy();
    });

    it("gives no program in a folder the bots write, even when PATH names it", () => {
      program(join(root, "home", ".local", "bin"), "planted-tool");
      distrustHomePrograms(join(root, "home"));
      expect(programViewFor("dsh", { env: { PATH: join(root, "home", ".local", "bin") } })?.find("planted-tool")).toBeUndefined();
    });
  });

  describe("for a name that is not a bare one", () => {
    it("never takes a file that exists relative to the working folder, nor a path written for another platform", () => {
      program(join(root, "sub"), "rel-tool");
      process.chdir(root);
      const view = programViewFor("dsh", { env: { PATH: join(root, "sub") } });
      expect(view?.find("rel-tool")).toBe(join(root, "sub", "rel-tool"));
      for (const name of ["./sub/rel-tool", "sub/rel-tool", "../sub/rel-tool", "C:\\tools\\rel-tool.exe", "\\\\host\\share\\rel-tool", "C:rel-tool", ""]) {
        expect(view?.find(name), name).toBeUndefined();
      }
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

    it("keeps a host program off the list when it or where it leads is a folder the bots write, as the launcher does", () => {
      const trusted = program(join(root, "trusted"), "ok-tool");
      const planted = program(join(root, "home", "bots"), "planted-tool");
      const answers: Record<string, string> = { "ok-tool": `${trusted}\0${trusted}\0`, "planted-tool": `${join(root, "trusted", "planted-tool")}\0${planted}\0`, "lost-tool": `${trusted}\0\0` };
      setHostRunnerForTests((argv) => argv[1] === "printenv" ? { status: 0, stdout: "/usr/bin\n" } : { status: 0, stdout: answers[String(argv.at(-1))] ?? "" });
      distrustHomePrograms(join(root, "home"));
      const view = programViewFor("dsh", { env: { PATH: join(root, "trusted") } });
      expect(view?.find("ok-tool")).toBe(trusted);
      expect(view?.find("planted-tool")).toBeUndefined();
      expect(view?.find("lost-tool")).toBeUndefined();
    });

    it("does not send a name with a path to the host at all", () => {
      const asked: string[] = [];
      setHostRunnerForTests((argv) => { asked.push(String(argv.at(-1))); return { status: 0, stdout: "" }; });
      const view = programViewFor("dsh", { env: { PATH: "/usr/bin" } });
      for (const name of ["sub/tool", "./tool", "/usr/bin/tool", "C:\\tool.exe"]) expect(view?.find(name), name).toBeUndefined();
      expect(asked).toEqual([]);
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
