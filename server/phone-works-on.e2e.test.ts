// A paired phone with the admin scope moves one bot between no computer and the server the host set up for it, and
// does nothing else to where a bot works.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLOUD_BACKEND_CHANGE_ERROR } from "./cloud-backend.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server/testing/fake-claude-cli.ts");
const NO_SERVER = "Set up your own server for this bot on the computer first.";

describe("a paired phone changes where one bot works", () => {
  let home = "";
  let release = "";
  let base = "";
  let child: ChildProcess | null = null;
  let output = "";
  let adminToken = "";
  let clientToken = "";

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json", origin: base,
        ...(token ? { authorization: `Bearer ${token}`, "x-seira-companion": "1" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const owner = async (method: string, path: string, body?: unknown) => {
    const result = await call(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  const pair = async (scopes: string[]) => {
    const { code } = await owner("POST", "/api/auth/pairing", { scopes });
    return (await owner("POST", "/api/auth/pair", { code })).token as string;
  };
  const newBot = async (name: string, patch: Record<string, unknown> = {}) => {
    const { bot } = await owner("POST", "/api/bots", { name });
    await owner("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, browser: false, ...patch });
    return bot.id as string;
  };
  const stored = async (botId: string) => (await owner("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId);
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "seira-phone-works-on-"));
    release = join(home, "release");
    const data = join(home, "data");
    const inertBrowser = join(home, "agent-browser");
    writeFileSync(inertBrowser, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
      claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release } },
    } }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, SEIRA_DATA_DIR: data, TEMP: home, TMP: home, TMPDIR: home,
        SEIRA_PORT: String(port), SEIRA_WEBHOOK_PORT: String(port + 1),
        SEIRA_AGENT_BROWSER_PATH: inertBrowser, AGENT_BROWSER_EXECUTABLE_PATH: inertBrowser,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (child!.exitCode !== null) throw new Error(`the server exited:\n${output}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, Boolean);
    adminToken = await pair(["admin", "client"]);
    clientToken = await pair(["client"]);
  }, 60_000);

  afterAll(async () => {
    writeFileSync(release, "");
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("tells an admin phone that this server accepts the change", { timeout: 60_000 }, async () => {
    const config = await call("GET", "/api/config", undefined, adminToken);
    expect(config.status).toBe(200);
    expect(config.body.phoneWorksOn).toBe(true);
  });

  it("AC-01: moves a bot to no computer and answers with the bot", { timeout: 60_000 }, async () => {
    const id = await newBot("Scout", { computer: "cloud" });
    const moved = await call("PATCH", `/api/bots/${id}`, { computer: "off" }, adminToken);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.bot).toMatchObject({ id, computer: "off" });
    expect((await stored(id)).computer).toBe("off");
  });

  it("AC-05: refuses the own server while the host has none, and changes nothing", { timeout: 60_000 }, async () => {
    const id = await newBot("Nomad", { computer: "off" });
    const refused = await call("PATCH", `/api/bots/${id}`, { computer: "cloud", cloudBackend: "vps" }, adminToken);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(NO_SERVER);
    expect(await stored(id)).toMatchObject({ computer: "off" });
  });

  it("AC-02 and AC-08: moves a bot to the server the host set up, and logs the device and the bot", { timeout: 60_000 }, async () => {
    const id = await newBot("Hosted", { computer: "off", vpsAlias: "own-vps" });
    const moved = await call("PATCH", `/api/bots/${id}`, { computer: "cloud", cloudBackend: "vps" }, adminToken);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await stored(id)).toMatchObject({ computer: "cloud", cloudBackend: "vps", vpsAlias: "own-vps" });
    const line = output.split("\n").find(row => row.includes(`[bots] paired device`) && row.includes(id));
    expect(line, output.slice(-2000)).toMatch(new RegExp(`\\[bots\\] paired device \\S+ moved bot ${id} to its own server$`));
    expect(line).not.toMatch(/Hosted|own-vps/);
  });

  it("AC-03: refuses every other value or field and changes nothing", { timeout: 60_000 }, async () => {
    const id = await newBot("Fixed", { computer: "cloud", vpsAlias: "own-vps" });
    const before = await stored(id);
    const attempts: Array<Record<string, unknown>> = [
      { computer: "local" }, { computer: "vm" }, { computer: "browser" }, { computer: null }, { computer: "cloud" },
      { computer: "cloud", cloudBackend: "box" }, { computer: "off", name: "Renamed" }, { computer: "off", vpsAlias: "other-vps" },
      { computer: "cloud", cloudBackend: "vps", vpsAlias: "other-vps" }, { computer: "off", approvalMode: "full" },
    ];
    for (const body of attempts) {
      const refused = await call("PATCH", `/api/bots/${id}`, body, adminToken);
      expect(refused.status, JSON.stringify(body)).toBe(403);
      expect(refused.body.error).toMatch(/^forbidden: a paired device may change how a bot looks, not "/);
    }
    expect(await stored(id)).toEqual(before);
  });

  it("AC-04: refuses a phone that only has the client scope", { timeout: 60_000 }, async () => {
    const id = await newBot("Guarded", { computer: "cloud", vpsAlias: "own-vps" });
    for (const body of [{ computer: "off" }, { computer: "cloud", cloudBackend: "vps" }]) {
      const refused = await call("PATCH", `/api/bots/${id}`, body, clientToken);
      expect(refused.status, JSON.stringify(body)).toBe(403);
    }
    expect(await stored(id)).toMatchObject({ computer: "cloud" });
  });

  it("AC-06: refuses the own server with the desktop's 409 while a turn runs", { timeout: 60_000 }, async () => {
    const id = await newBot("Busy", { computer: "off", vpsAlias: "own-vps" });
    await owner("POST", `/api/bots/${id}/messages`, { text: "hold" });
    await until(() => stored(id), bot => bot?.busy === true);
    const refused = await call("PATCH", `/api/bots/${id}`, { computer: "cloud", cloudBackend: "vps" }, adminToken);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(CLOUD_BACKEND_CHANGE_ERROR);
    expect((await stored(id)).computer).toBe("off");
  });
});
