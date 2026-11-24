import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { findCliCandidates, runnableFile } from "../../env-path.ts";
import { programViewFor, type ProgramView } from "../../procs.ts";
import type { AcpMcpServer } from "../turn-mcp.ts";
import { absoluteMcpCommands, skippedMcpNote, turnMcpCommands } from "./mcp-commands.ts";

/** A view of this computer on `path`, as procs.ts makes one. */
const viewOf = (path: string): ProgramView => ({ find: (name) => findCliCandidates(name, path).find((found) => runnableFile(found) !== null) });

const stdio = (name: string, command: string): AcpMcpServer => ({ name, command, args: ["server.py"], env: [{ name: "K", value: "v" }] });

describe.skipIf(process.platform === "win32")("absoluteMcpCommands", () => {
  let root: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seira-mcp-cmd-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "fake-python"), "#!/bin/sh\n");
    chmodSync(join(bin, "fake-python"), 0o755);
    writeFileSync(join(bin, "not-executable"), "data");
    chmodSync(join(bin, "not-executable"), 0o644);
    mkdirSync(join(bin, "a-directory"));
  });
  afterEach(async () => {
    await removeTempDir(root);
  });

  it("resolves a bare command to an absolute path and keeps args and env", () => {
    const { servers, skipped } = absoluteMcpCommands([stdio("py", "fake-python")], viewOf(bin));
    expect(skipped).toEqual([]);
    expect(servers).toEqual([{ name: "py", command: join(bin, "fake-python"), args: ["server.py"], env: [{ name: "K", value: "v" }] }]);
  });

  it("takes the first match on a PATH with several directories", () => {
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "fake-python"), "#!/bin/sh\n");
    chmodSync(join(other, "fake-python"), 0o755);
    const { servers } = absoluteMcpCommands([stdio("py", "fake-python")], viewOf([join(root, "missing"), other, bin].join(delimiter)));
    expect(servers[0]).toMatchObject({ command: join(other, "fake-python") });
  });

  it("leaves an absolute command unchanged, even one that does not exist", () => {
    const absolute = join(root, "elsewhere", "server");
    const { servers, skipped } = absoluteMcpCommands([stdio("abs", absolute)], viewOf(bin));
    expect(skipped).toEqual([]);
    expect(servers).toEqual([stdio("abs", absolute)]);
  });

  it("skips only the server whose command cannot be resolved and names it", () => {
    const { servers, skipped } = absoluteMcpCommands(
      [stdio("first", "fake-python"), stdio("lost", "no-such-command-480"), stdio("last", join(root, "x"))], viewOf(bin));
    expect(servers.map((server) => server.name)).toEqual(["first", "last"]);
    expect(skipped).toEqual([{ name: "lost", command: "no-such-command-480", looked: true }]);
    expect(skippedMcpNote("DeepSeek Harness", skipped[0]!)).toContain('"lost"');
    expect(skippedMcpNote("DeepSeek Harness", skipped[0]!)).toContain("no-such-command-480");
  });

  it("skips a command that is not an executable file", () => {
    const { servers, skipped } = absoluteMcpCommands([stdio("data", "not-executable"), stdio("dir", "a-directory")], viewOf(bin));
    expect(servers).toEqual([]);
    expect(skipped.map((entry) => entry.name)).toEqual(["data", "dir"]);
  });

  it("skips a relative path that exists from the working folder: it never reaches the agent", () => {
    const startDir = process.cwd();
    process.chdir(bin);
    try {
      const { servers, skipped } = absoluteMcpCommands([stdio("rel", "./fake-python"), stdio("sub", "../bin/fake-python")], programViewFor("dsh", { env: { PATH: bin } }));
      expect(servers).toEqual([]);
      expect(skipped.map((entry) => entry.name)).toEqual(["rel", "sub"]);
    } finally {
      process.chdir(startDir);
    }
  });

  it("skips a command written for another platform instead of passing it on", () => {
    const { servers, skipped } = absoluteMcpCommands([stdio("win", "C:\\tools\\mcp.exe"), stdio("unc", "\\\\host\\share\\mcp.exe")], viewOf(bin));
    expect(servers).toEqual([]);
    expect(skipped.map((entry) => entry.name)).toEqual(["win", "unc"]);
  });

  it("skips a relative path with a slash instead of guessing a base folder", () => {
    const { servers, skipped } = absoluteMcpCommands([stdio("rel", "./fake-python")], viewOf(bin));
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "rel", command: "./fake-python", looked: true }]);
  });

  it("skips every bare command, and says it could not look, when there is no view of where the engine runs", () => {
    const { servers, skipped } = absoluteMcpCommands([stdio("py", "fake-python")], null);
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "py", command: "fake-python", looked: false }]);
    const note = skippedMcpNote("DeepSeek Harness", skipped[0]!);
    expect(note).toContain("could not be looked up where it runs");
    expect(note).not.toContain("was not found on PATH");
  });

  it("says a command was not found on PATH only when it was looked up", () => {
    const { skipped } = absoluteMcpCommands([stdio("lost", "no-such-command-480")], viewOf(bin));
    expect(skippedMcpNote("DeepSeek Harness", skipped[0]!)).toContain("was not found on PATH where it runs");
  });

  it("passes an http server through untouched", () => {
    const remote: AcpMcpServer = { type: "http", name: "docs", url: "https://docs.example/mcp", headers: [] };
    expect(absoluteMcpCommands([remote], null)).toEqual({ servers: [remote], skipped: [] });
  });

  it("turnMcpCommands passes servers through unless the agent needs absolute commands", () => {
    const servers = [stdio("py", "fake-python")];
    expect(turnMcpCommands(servers, undefined)).toEqual({ servers, notes: [] });
    const needed = turnMcpCommands([...servers, stdio("lost", "no-such-command-480")], { view: viewOf(bin), engine: "DeepSeek Harness" });
    expect(needed.servers.map((server) => server.name)).toEqual(["py"]);
    expect(needed.notes).toHaveLength(1);
    expect(needed.notes[0]).toContain('"lost"');
  });
});
