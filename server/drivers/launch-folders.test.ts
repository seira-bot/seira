import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(SERVER, "testing", "cut-off-launch.mjs");
const FAKE_CLAUDE = join(SERVER, "testing", "fake-claude-cli.ts");

// An agent that starts and then never answers; it ends when its parent does and closes its input.
const SILENT_AGENT = `process.stdin.resume(); process.stdin.on("close", () => process.exit(0)); setInterval(() => {}, 1 << 30);`;

interface CutOff {
  pid: number;
  folders: Record<string, string[]>;
  tmp: string;
}

/** Runs the call in a process that exits in the middle of it, with its own temp folder, and says what it left. */
function cutOff(scenario: "muse" | "acp" | "background" | "turn", env: Record<string, string> = {}): CutOff {
  const root = mkdtempSync(join(tmpdir(), "seira-cut-off-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  mkdirSync(home);
  mkdirSync(tmp);
  let cli = FAKE_CLAUDE;
  if (scenario === "muse" || scenario === "acp") {
    writeFileSync(join(root, "silent-agent.mjs"), SILENT_AGENT);
    cli = join(root, "agent");
    writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "silent-agent.mjs"))} "$@"\n`, { mode: 0o755 });
  } else {
    chmodSync(FAKE_CLAUDE, 0o755);
  }
  const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, scenario, cli], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env },
  });
  expect(run.status, run.stderr).toBe(0);
  return { ...(JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as Omit<CutOff, "tmp">), tmp };
}

function expectOwnedAndGone(left: CutOff, prefix: string): void {
  const folders = left.folders[prefix] ?? [];
  expect(folders.length, `a folder ${prefix}* while the call ran`).toBeGreaterThan(0);
  for (const folder of folders) {
    expect(dirname(folder)).toBe(left.tmp);
    expect(basename(folder)).toMatch(new RegExp(`^${prefix}${left.pid}-[A-Za-z0-9]{6}$`));
    expect(existsSync(folder), `${folder} after the process exited`).toBe(false);
  }
}

describe.skipIf(process.platform === "win32")("the temp folder of a call that a process leaves unfinished", () => {
  it("goes with the process when it ends in the middle of a Muse Code model list", () => {
    expectOwnedAndGone(cutOff("muse"), "seira-muse-models-");
  });

  it("goes with the process when it ends in the middle of an ACP model discovery", () => {
    expectOwnedAndGone(cutOff("acp"), "seira-acp-models-");
  });

  it("goes with the process when it ends in the middle of a one-off Claude call", () => {
    expectOwnedAndGone(cutOff("background", { FAKE_CLAUDE_TEXT_HANG: "1" }), "seira-claude-background-");
  });

  it("goes with the process when it ends in the middle of a Claude turn: the MCP config and the system prompt", () => {
    const left = cutOff("turn", { FAKE_CLAUDE_MODE: "hang" });
    expectOwnedAndGone(left, "seira-mcp-");
    expectOwnedAndGone(left, "seira-system-");
  });
});
