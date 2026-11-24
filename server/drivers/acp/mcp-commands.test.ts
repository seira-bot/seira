import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import type { AcpMcpServer } from "../turn-mcp.ts";
import { absoluteMcpCommands, skippedMcpNote, turnMcpCommands } from "./mcp-commands.ts";

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
    const { servers, skipped } = absoluteMcpCommands([stdio("py", "fake-python")], bin);
    expect(skipped).toEqual([]);
    expect(servers).toEqual([{ name: "py", command: join(bin, "fake-python"), args: ["server.py"], env: [{ name: "K", value: "v" }] }]);
  });

  it("takes the first match on a PATH with several directories", () => {
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "fake-python"), "#!/bin/sh\n");
    chmodSync(join(other, "fake-python"), 0o755);
    const { servers } = absoluteMcpCommands([stdio("py", "fake-python")], [join(root, "missing"), other, bin].join(delimiter));
    expect(servers[0]).toMatchObject({ command: join(other, "fake-python") });
  });

  it("leaves an absolute command unchanged, even one that does not exist", () => {
    const absolute = join(root, "elsewhere", "server");
    const { servers, skipped } = absoluteMcpCommands([stdio("abs", absolute)], bin);
    expect(skipped).toEqual([]);
    expect(servers).toEqual([stdio("abs", absolute)]);
  });

  it("skips only the server whose command cannot be resolved and names it", () => {
    const { servers, skipped } = absoluteMcpCommands(
      [stdio("first", "fake-python"), stdio("lost", "no-such-command-480"), stdio("last", join(root, "x"))], bin);
    expect(servers.map((server) => server.name)).toEqual(["first", "last"]);
    expect(skipped).toEqual([{ name: "lost", command: "no-such-command-480" }]);
    expect(skippedMcpNote("DeepSeek Harness", skipped[0]!)).toContain('"lost"');
    expect(skippedMcpNote("DeepSeek Harness", skipped[0]!)).toContain("no-such-command-480");
  });

  it("skips a command that is not an executable file", () => {
    const { servers, skipped } = absoluteMcpCommands([stdio("data", "not-executable"), stdio("dir", "a-directory")], bin);
    expect(servers).toEqual([]);
    expect(skipped.map((entry) => entry.name)).toEqual(["data", "dir"]);
  });

  it("skips a relative path with a slash instead of guessing a base folder", () => {
    const { servers, skipped } = absoluteMcpCommands([stdio("rel", "./fake-python")], bin);
    expect(servers).toEqual([]);
    expect(skipped).toEqual([{ name: "rel", command: "./fake-python" }]);
  });

  it("skips every bare command when there is no PATH", () => {
    const { skipped } = absoluteMcpCommands([stdio("py", "fake-python")], undefined);
    expect(skipped).toEqual([{ name: "py", command: "fake-python" }]);
  });

  it("passes an http server through untouched", () => {
    const remote: AcpMcpServer = { type: "http", name: "docs", url: "https://docs.example/mcp", headers: [] };
    expect(absoluteMcpCommands([remote], "")).toEqual({ servers: [remote], skipped: [] });
  });

  it("turnMcpCommands passes servers through unless the agent needs absolute commands", () => {
    const servers = [stdio("py", "fake-python")];
    expect(turnMcpCommands(servers, undefined)).toEqual({ servers, notes: [] });
    const needed = turnMcpCommands([...servers, stdio("lost", "no-such-command-480")], { path: bin, engine: "DeepSeek Harness" });
    expect(needed.servers.map((server) => server.name)).toEqual(["py"]);
    expect(needed.notes).toHaveLength(1);
    expect(needed.notes[0]).toContain('"lost"');
  });
});
