import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The real server on an isolated data folder: what Boat left there is gone after the first start, and a second start
// finds nothing more to change.
describe("starting the server on a data folder that still holds Boat", () => {
  const home = mkdtempSync(join(tmpdir(), "seira-boat-gone-"));
  const data = join(home, "data");
  let output = "";
  let child: ChildProcess | null = null;

  async function start() {
    const port = await freePortBlock([0, 1]);
    output = "";
    child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home, SEIRA_DATA_DIR: data, TEMP: home, TMP: home, TMPDIR: home,
        SEIRA_PORT: String(port), SEIRA_WEBHOOK_PORT: String(port + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    const end = Date.now() + 40_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the server exited:\n${output}`);
      try { if ((await fetch(`${base}/api/health`)).ok) return base; } catch { /* not up yet */ }
      if (Date.now() > end) throw new Error(`the server did not start:\n${output.slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const stop = async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); child = null; };
  const json = (name: string) => JSON.parse(readFileSync(join(data, name), "utf8"));

  afterAll(async () => { await stop(); await removeTempDir(home); });

  it("removes the Boat key and moves a Cloud bot to no computer, then changes nothing", { timeout: 120_000 }, async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ box: { token: "boat-key-123" }, language: "en" }));
    let base = await start();
    expect(json("config.json")).not.toHaveProperty("box");
    expect(json("config.json").language).toBe("en");
    expect(output).toContain("[boat] removed 1 Boat keys");
    expect(output).not.toContain("boat-key-123");
    const { bots } = await (await fetch(`${base}/api/bots?messages=0`)).json() as { bots: Array<{ id: string }> };
    await stop();

    const saved = json("bots.json") as Array<Record<string, unknown>>;
    Object.assign(saved.find(bot => bot.id === bots[0]!.id)!, { computer: "cloud", cloudBackend: "box" });
    writeFileSync(join(data, "bots.json"), JSON.stringify(saved));
    base = await start();
    const { bots: after } = await (await fetch(`${base}/api/bots?messages=0`)).json() as { bots: Array<{ id: string; computer?: string; cloudBackend?: string }> };
    expect(after.find(bot => bot.id === bots[0]!.id)).toMatchObject({ computer: "off" });
    expect(after.find(bot => bot.id === bots[0]!.id)?.cloudBackend).toBeUndefined();
    expect(output).toContain("[boat] moved 1 bots off Boat");
    await stop();

    const settled = readFileSync(join(data, "bots.json"), "utf8"), config = readFileSync(join(data, "config.json"), "utf8");
    await start();
    expect(output).not.toContain("[boat]");
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe(settled);
    expect(readFileSync(join(data, "config.json"), "utf8")).toBe(config);
  });
});
