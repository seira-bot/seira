import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server/testing/fake-claude-cli.ts");

describe("a bot set to Cloud answers when no cloud computer is set up", () => {
  let home = "";
  let dumpFile = "";
  let inertBrowser = "";
  let base = "";
  let child: ChildProcess | null = null;
  let output = "";
  let events: SseRecorder;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const messages = async (threadId: string) =>
    (await apiOk("GET", `/api/threads/${threadId}/messages?limit=80`)).messages as any[];
  const idle = (botId: string) => until(async () => (await apiOk("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId),
    bot => bot?.busy === false);
  const dump = () => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
  }, Boolean);
  const say = async (botId: string, threadId: string, text: string) => {
    rmSync(dumpFile, { force: true });
    await apiOk("POST", `/api/bots/${botId}/messages`, { text, threadId });
    const sent = await dump().catch(async (error) => {
      throw new Error(`${error.message}\nrows: ${JSON.stringify((await messages(threadId)).map(row => row.tool ?? row.text))}`);
    });
    await idle(botId);
    return sent;
  };
  const notices = (rows: any[]) => rows.filter(row => row.tool?.place?.state === "cc-not-set-up");
  const failures = (rows: any[]) => rows.filter(row => row.tool?.name?.startsWith("error:") && !row.tool?.notice);
  const bot = async (name: string, patch: Record<string, unknown>) => {
    const { bot: made } = await apiOk("POST", "/api/bots", { name });
    await apiOk("PATCH", `/api/bots/${made.id}`, {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, browser: false, ...patch,
    });
    return made as { id: string; threadId: string };
  };
  const mounted = (sent: any) => Object.keys(sent.mcpConfig?.mcpServers ?? {});
  const prompt = (sent: any) => String(sent.systemPrompt ?? "");
  // What this turn's own Surface part says when the bot may move itself to another computer, or when this computer is a
  // place it could pick (the standing text about choosing a computer is conditional on that part and always present).
  const offersAnotherComputer = (sent: any) => /This turn you may choose where to work|inspect connected choices with select_computer|"my PC"/.test(prompt(sent));
  const computerPlaces = () => events.frames.filter(frame => frame.kind === "computer").map(frame => frame.place);

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "seira-no-cloud-"));
    const data = join(home, "data");
    dumpFile = join(home, "dump.json");
    inertBrowser = join(home, "agent-browser");
    writeFileSync(inertBrowser, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
      claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_DUMP: dumpFile } },
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
    }, Boolean, 30_000);
    const seeded = (await apiOk("GET", "/api/bots?messages=0")).bots.find((one: any) => one.chiefOfStaff);
    await apiOk("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
    events = await openSse(`${base}/api/events`);
    await events.until(frame => frame.kind === "hello");
  }, 60_000);

  afterAll(async () => {
    events?.close();
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("runs a bot whose Works on is Cloud without any computer, and says so once", { timeout: 60_000 }, async () => {
    const made = await bot("Cloudy", { computer: "cloud" });
    const first = await say(made.id, made.threadId, "hello");
    expect(mounted(first)).not.toContain("computer");
    expect(offersAnotherComputer(first), "no other computer offered").toBe(false);
    expect(prompt(first)).toContain("for the whole request");
    const afterFirst = await messages(made.threadId);
    expect(failures(afterFirst)).toEqual([]);
    expect(afterFirst.some(row => row.role === "bot" && row.kind === "text")).toBe(true);
    expect(notices(afterFirst)).toHaveLength(1);
    const [notice] = notices(afterFirst);
    expect(notice.tool).toMatchObject({ ok: false, notice: true, place: { state: "cc-not-set-up", source: "works-on" } });
    expect(notice.tool.name).not.toMatch(/boat/i);
    expect(notice.tool.name).toMatch(/server/i);

    const second = await say(made.id, made.threadId, "hello again");
    expect(mounted(second)).not.toContain("computer");
    expect(offersAnotherComputer(second)).toBe(false);
    const afterSecond = await messages(made.threadId);
    expect(notices(afterSecond)).toHaveLength(1);
    expect(failures(afterSecond)).toEqual([]);
    expect(computerPlaces()).not.toContain("local");
    expect(computerPlaces()).not.toContain("vm");
  });

  it("runs a bot whose Cloud is a VPS that is not set up without any computer, and says so once", { timeout: 60_000 }, async () => {
    const made = await bot("No VPS", { computer: "cloud", cloudBackend: "vps" });
    const first = await say(made.id, made.threadId, "hello");
    expect(mounted(first)).not.toContain("computer");
    expect(offersAnotherComputer(first), "no other computer offered").toBe(false);
    const second = await say(made.id, made.threadId, "hello again");
    expect(mounted(second)).not.toContain("computer");
    const rows = await messages(made.threadId);
    expect(failures(rows)).toEqual([]);
    expect(rows.filter(row => row.role === "bot" && row.kind === "text").length).toBeGreaterThanOrEqual(2);
    expect(notices(rows)).toHaveLength(1);
    expect(notices(rows)[0].tool).toMatchObject({ notice: true, place: { state: "cc-not-set-up", source: "works-on" } });
    expect(JSON.stringify(notices(rows)[0].tool)).not.toMatch(/boat/i);
    expect(computerPlaces()).not.toContain("local");
    expect(computerPlaces()).not.toContain("vm");
  });

  it("runs a thread pinned to Cloud by hand without any computer, and says so once", { timeout: 60_000 }, async () => {
    const made = await bot("Pinned", {});
    await apiOk("PATCH", `/api/bots/${made.id}/tasks/${made.threadId}`, { surface: "cloud" });
    const first = await say(made.id, made.threadId, "hello");
    expect(mounted(first)).not.toContain("computer");
    expect(offersAnotherComputer(first), "no other computer offered").toBe(false);
    const second = await say(made.id, made.threadId, "and again");
    expect(mounted(second)).not.toContain("computer");
    expect(offersAnotherComputer(second)).toBe(false);
    const rows = await messages(made.threadId);
    expect(failures(rows)).toEqual([]);
    expect(notices(rows)).toHaveLength(1);
    expect(notices(rows)[0].tool.place.source).toBe("pin");
    expect(rows.filter(row => row.role === "bot" && row.kind === "text").length).toBeGreaterThanOrEqual(2);
    expect(computerPlaces()).not.toContain("local");
    expect(computerPlaces()).not.toContain("vm");
  });

  it("runs a room member whose Works on is Cloud without any computer, and says so once", { timeout: 60_000 }, async () => {
    const made = await bot("Room member", { computer: "cloud" });
    const { group } = await apiOk("POST", "/api/groups", { name: "No cloud room", memberIds: [made.id] });
    await apiOk("PATCH", `/api/groups/${group.id}/setup`, { action: "skip" });
    for (const text of ["hi", "hi again"]) {
      rmSync(dumpFile, { force: true });
      await apiOk("POST", `/api/groups/${group.id}/messages`, { text });
      const sent = await dump();
      expect(mounted(sent)).not.toContain("computer");
      expect(offersAnotherComputer(sent)).toBe(false);
      await idle(made.id);
    }
    const rows = await messages(group.threadId ?? group.id);
    expect(failures(rows)).toEqual([]);
    expect(notices(rows)).toHaveLength(1);
    expect(notices(rows)[0].tool.place.source).toBe("room");
    expect(computerPlaces()).not.toContain("local");
  });

  it("still offers the switch to a bot whose Works on is Auto, so the checks above mean something", { timeout: 60_000 }, async () => {
    const made = await bot("Auto", {});
    const sent = await say(made.id, made.threadId, "hello");
    expect(offersAnotherComputer(sent)).toBe(true);
  });

  it("keeps the built-in browser, and says so, when the bot has it on (chat, pin and room)", { timeout: 90_000 }, async () => {
    const withBrowser = { browser: true, browserProfile: "guest" };
    const worksOn = await bot("Cloud browser", { computer: "cloud", ...withBrowser });
    const direct = await say(worksOn.id, worksOn.threadId, "hello");
    expect(mounted(direct)).toContain("browser");
    expect(mounted(direct)).not.toContain("computer");
    expect(prompt(direct)).toContain("no desktop computer is mounted this turn");
    expect(prompt(direct)).toContain("The built-in browser is the only screen you may have");
    expect(prompt(direct)).not.toContain("No computer or built-in browser tools are mounted");
    expect(offersAnotherComputer(direct)).toBe(false);

    const pinned = await bot("Pinned browser", withBrowser);
    await apiOk("PATCH", `/api/bots/${pinned.id}/tasks/${pinned.threadId}`, { surface: "cloud" });
    const pin = await say(pinned.id, pinned.threadId, "hello");
    expect(mounted(pin)).toContain("browser");
    expect(mounted(pin)).not.toContain("computer");
    expect(offersAnotherComputer(pin)).toBe(false);
    expect(notices(await messages(pinned.threadId))).toHaveLength(1);

    const member = await bot("Room browser", { computer: "cloud", ...withBrowser });
    const { group } = await apiOk("POST", "/api/groups", { name: "No cloud browser room", memberIds: [member.id] });
    await apiOk("PATCH", `/api/groups/${group.id}/setup`, { action: "skip" });
    rmSync(dumpFile, { force: true });
    await apiOk("POST", `/api/groups/${group.id}/messages`, { text: "hi" });
    const room = await dump();
    expect(mounted(room)).toContain("browser");
    expect(mounted(room)).not.toContain("computer");
    expect(prompt(room)).toContain("The built-in browser is the only screen you may have");
    await idle(member.id);
    expect(failures(await messages(group.threadId ?? group.id))).toEqual([]);
    expect(computerPlaces()).not.toContain("local");
    expect(computerPlaces()).not.toContain("vm");
  });

  it("still fails a routine that runs on the cloud computer, instead of running it without one", async () => {
    const made = await bot("Routiner", { computer: "cloud" });
    const { routine } = await apiOk("POST", "/api/routines", {
      name: "Cloud run", prompt: "say hi", target: "bot", botId: made.id, runOn: "cloud", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const { run } = await apiOk("POST", `/api/routines/${routine.id}/run`, {});
    const finished = await until(
      async () => (await apiOk("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id),
      (candidate: any) => Boolean(candidate) && !["queued", "running", "waiting"].includes(candidate.status),
      45_000,
    );
    expect(finished.status).toBe("failed");
    const rows = await messages(finished.threadId);
    expect(notices(rows)).toEqual([]);
    expect(failures(rows)).toHaveLength(1);
  }, 60_000);
});
