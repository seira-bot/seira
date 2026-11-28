// The AI pool, end to end against a real server with fake engines: at the start of a turn a conversation moves to the
// pool member with more usage left and gets one line that names both AIs; it stays when its own AI has the most left;
// and it never moves when the pool is off or its AI is not in the pool. The usage fixture file gives each engine its
// reading, and a limits read before the turn stands in for the clock's own first read. A person's model switch reaches the
// server two ways, and each has its own test: the REST route, and the desktop app's private port (the confirmed switch).
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlSeira, verificationServerEnvironment } from "../scripts/control-seira.ts";
import { waitForExit } from "./testing/cleanup.ts";

const codex = { instanceId: "codex", model: "gpt-fake-default" };
const jsonLines = (path: string): unknown[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

const usageRow = (id: string, name: string, driver: string, usedPercent: number) => ({
  id, name, driver, plan: null, ok: true, error: null,
  fiveHour: { available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
  weekly: { available: false, usedPercent: null, remainingPercent: null, resetsAt: null },
  extra: [], models: [],
});

interface Fixture {
  api: (method: string, path: string, body?: unknown, expectedStatus?: number) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  claudePrompts: () => unknown[];
  evidence: unknown[];
  /** The desktop app's confirmed model switch: sends one private message and returns the app's answer to it. */
  desktopSwitch: (message: Record<string, unknown>) => Promise<any>;
}

async function withPoolFixture(setup: { claudeUsed: number; codexUsed: number; secondClaude?: boolean; desktop?: boolean }, check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const promptsFile = join(dataDir, "claude-prompts.jsonl");
  const usageFile = join(dataDir, "plan-usage.json");
  const inbox = join(dataDir, "desktop-inbox.jsonl");
  const outbox = join(dataDir, "desktop-outbox.jsonl");
  const evidence: unknown[] = [{ url, setup }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    const context = `${method} ${path}: ${JSON.stringify(result)}`;
    if (expectedStatus === undefined) expect(response.ok, context).toBe(true);
    else expect(response.status, context).toBe(expectedStatus);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlSeira([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_PROMPTS: promptsFile, FAKE_CLAUDE_TOOL_CALLS: "[]" };
    config.instances.codex = { driver: "codex", config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) } };
    if (setup.secondClaude) config.instances.claudeWork = { ...config.instances.claude, displayName: "Second Claude sign-in" };
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(usageFile, JSON.stringify({ providers: [
      usageRow("claude", "Verification fixture", "claude", setup.claudeUsed), usageRow("codex", "Codex", "codex", setup.codexUsed),
    ] }));
    const log = openSync(logPath, "a", 0o600);
    if (setup.desktop) { writeFileSync(inbox, ""); writeFileSync(outbox, ""); }
    const desktopPort = setup.desktop ? ["--import", pathToFileURL(fileURLToPath(new URL("./testing/desktop-parent.mjs", import.meta.url))).href] : [];
    server = spawn(process.execPath, ["--experimental-strip-types", ...desktopPort, fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), SEIRA_TEST_PLAN_USAGE_FILE: usageFile,
        ...(setup.desktop ? { SEIRA_TEST_DESKTOP_INBOX: inbox, SEIRA_TEST_DESKTOP_OUTBOX: outbox } : {}),
      },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances") as { instances: any[] };
      return instances.find((instance) => instance.instanceId === "codex")?.models.options.some((option: any) => option.id === codex.model);
    }, { timeout: 20_000 }).toBe(true);
    // Chief first makes the starter its team's Chief, whose own turns on Claude would be counted with the ones under test.
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    await api("PATCH", `/api/bots/${bots.find((bot) => bot.chiefOfStaff)!.id}`, { chiefOfStaff: false });
    const desktopSwitch = async (message: Record<string, unknown>) => {
      const requestId = `switch-${evidence.length}`;
      appendFileSync(inbox, `${JSON.stringify({ type: "approval-trusted-mode-set", requestId, ...message })}\n`);
      let answer: any;
      await expect.poll(() => (answer = jsonLines(outbox).find((line: any) => line.requestId === requestId)), { timeout: 10_000 }).toBeTruthy();
      evidence.push({ desktopSwitch: message, answer });
      return answer;
    };
    await check({ api, control, evidence, claudePrompts: () => jsonLines(promptsFile), desktopSwitch });
  } finally {
    const evidencePath = `${logPath}.ai-pool.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

const messagesOf = async (api: Fixture["api"], threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const recoveryLines = (messages: any[]) => messages.filter((message) => message.tool?.name?.startsWith("recovery: ")).map((message) => message.tool.name as string);
const lastReply = (messages: any[]) => messages.findLast((message) => message.role === "bot" && message.kind === "text");

/** A bot on Claude sends one message under the given pool; returns what the conversation shows afterwards. */
async function oneTurn({ api, control }: Fixture, pool: (claude: { instanceId: string; model: string }) => unknown, beforeSend?: (bot: { id: string }, threadId: string) => Promise<void>) {
  const { bot } = await control("new-bot", "--name", "Pooled");
  const threadId = bot.activeTaskId;
  const claude = { instanceId: "claude", model: (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection.model };
  await api("PATCH", "/api/config", { aiPool: pool(claude) });
  // The first read of every engine's usage, which the clock would make within a minute of its start.
  await api("GET", "/api/limit-resets?refresh=1");
  await beforeSend?.(bot, threadId);
  await control("send", "--bot", bot.id, "--task", threadId, "--text", "Plan the week");
  expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
  const messages = await messagesOf(api, threadId);
  const task = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId);
  return { messages, model: (task.modelSelection ?? claude) as { instanceId: string }, bot, threadId, claude };
}

it("moves a conversation to the AI with more usage left, and says so in one line", async () => {
  await withPoolFixture({ claudeUsed: 70, codexUsed: 10 }, async (fixture) => {
    const { messages, model } = await oneTurn(fixture, (claude) => ({ enabled: true, mode: "even", members: [claude, codex] }));
    expect(recoveryLines(messages)).toEqual(["recovery: Codex has more usage left, so this conversation moved from Verification fixture to Codex."]);
    expect(model).toMatchObject({ instanceId: "codex" });
    expect(lastReply(messages)).toMatchObject({ text: "done from fake codex" });
    expect(fixture.claudePrompts()).toHaveLength(0);
    fixture.evidence.push({ messages });
  });
}, 120_000);

it("keeps a conversation where it is when its own AI has the most usage left", async () => {
  await withPoolFixture({ claudeUsed: 10, codexUsed: 70 }, async (fixture) => {
    const { messages, model } = await oneTurn(fixture, (claude) => ({ enabled: true, mode: "even", members: [claude, codex] }));
    expect(recoveryLines(messages)).toEqual([]);
    expect(model).toMatchObject({ instanceId: "claude" });
    expect(lastReply(messages)).toMatchObject({ text: "hello from fake claude" });
    expect(fixture.claudePrompts()).toHaveLength(1);
  });
}, 120_000);

it("moves nothing while the pool is off", async () => {
  await withPoolFixture({ claudeUsed: 70, codexUsed: 10 }, async (fixture) => {
    const { messages, model } = await oneTurn(fixture, (claude) => ({ enabled: false, mode: "even", members: [claude, codex] }));
    expect(recoveryLines(messages)).toEqual([]);
    expect(model).toMatchObject({ instanceId: "claude" });
    expect(lastReply(messages)).toMatchObject({ text: "hello from fake claude" });
    expect(fixture.claudePrompts()).toHaveLength(1);
  });
}, 120_000);

it("moves nothing for a conversation whose AI is not in the pool", async () => {
  await withPoolFixture({ claudeUsed: 70, codexUsed: 10, secondClaude: true }, async (fixture) => {
    const { messages, model } = await oneTurn(fixture, () => ({ enabled: true, mode: "even", members: [codex, { instanceId: "claudeWork", model: "claude-sonnet-5" }] }));
    expect(recoveryLines(messages)).toEqual([]);
    expect(model).toMatchObject({ instanceId: "claude" });
    expect(lastReply(messages)).toMatchObject({ text: "hello from fake claude" });
    expect(fixture.claudePrompts()).toHaveLength(1);
  });
}, 120_000);

it("leaves a conversation alone whose model a person switched to a pool member that is not the bot's own", async () => {
  await withPoolFixture({ claudeUsed: 10, codexUsed: 70 }, async (fixture) => {
    const { messages, model } = await oneTurn(fixture, (claude) => ({ enabled: true, mode: "even", members: [claude, codex] }),
      async (bot, threadId) => { await fixture.control("set-model", "--bot", bot.id, "--instance", codex.instanceId, "--model", codex.model, "--task", threadId); });
    expect(recoveryLines(messages)).toEqual([]);
    expect(model).toMatchObject({ instanceId: "codex" });
    expect(lastReply(messages)).toMatchObject({ text: "done from fake codex" });
    expect(fixture.claudePrompts()).toHaveLength(0);
  });
}, 120_000);

it("keeps the AI a person picked from a client that sends no aiPool", async () => {
  await withPoolFixture({ claudeUsed: 70, codexUsed: 10 }, async (fixture) => {
    const { api, control } = fixture;
    const first = await oneTurn(fixture, (claude) => ({ enabled: true, mode: "even", members: [claude, codex] }));
    expect(first.model).toMatchObject({ instanceId: "codex" });
    await api("PATCH", `/api/bots/${first.bot.id}/tasks/${first.threadId}`, { modelSelection: first.claude });
    await control("send", "--bot", first.bot.id, "--task", first.threadId, "--text", "And the next day");
    expect((await control("wait", "--bot", first.bot.id, "--task", first.threadId, "--timeout", "30")).status).toBe("settled");
    const task = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === first.bot.id).tasks.find((entry: any) => entry.threadId === first.threadId);
    const messages = await messagesOf(api, first.threadId);
    expect(task.aiPool).toBe("pinned");
    expect(task.modelSelection ?? first.claude).toMatchObject({ instanceId: "claude" });
    expect(recoveryLines(messages)).toHaveLength(1);
    expect(lastReply(messages)).toMatchObject({ text: "hello from fake claude" });
    expect(fixture.claudePrompts()).toHaveLength(1);
  });
}, 120_000);

const taskOf = async (api: Fixture["api"], botId: string, threadId: string) =>
  (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === botId).tasks.find((entry: any) => entry.threadId === threadId);

it("keeps the AI a person picked in the desktop app, which sends no aiPool", async () => {
  await withPoolFixture({ claudeUsed: 70, codexUsed: 10, desktop: true }, async (fixture) => {
    const { api, control } = fixture;
    const first = await oneTurn(fixture, (claude) => ({ enabled: true, mode: "even", members: [claude, codex] }));
    expect(first.model).toMatchObject({ instanceId: "codex" });
    expect((await taskOf(api, first.bot.id, first.threadId)).aiPool).toBe("auto");
    const answer = await fixture.desktopSwitch({ botId: first.bot.id, threadId: first.threadId, mode: "ask", modelSelection: first.claude, updateBotDefault: false });
    expect(answer).toMatchObject({ type: "approval-trusted-mode-result", ok: true });
    expect((await taskOf(api, first.bot.id, first.threadId)).aiPool).toBe("pinned");
    await control("send", "--bot", first.bot.id, "--task", first.threadId, "--text", "And the next day");
    expect((await control("wait", "--bot", first.bot.id, "--task", first.threadId, "--timeout", "30")).status).toBe("settled");
    const task = await taskOf(api, first.bot.id, first.threadId);
    const messages = await messagesOf(api, first.threadId);
    expect(task.aiPool).toBe("pinned");
    expect(task.modelSelection ?? first.claude).toMatchObject({ instanceId: "claude" });
    expect(recoveryLines(messages)).toHaveLength(1);
    expect(lastReply(messages)).toMatchObject({ text: "hello from fake claude" });
    expect(fixture.claudePrompts()).toHaveLength(1);
  });
}, 120_000);

it("leaves a pool conversation on auto when the desktop app confirms the AI it is already on", async () => {
  await withPoolFixture({ claudeUsed: 70, codexUsed: 10, desktop: true }, async (fixture) => {
    const { api } = fixture;
    const first = await oneTurn(fixture, (claude) => ({ enabled: true, mode: "even", members: [claude, codex] }));
    const before = await taskOf(api, first.bot.id, first.threadId);
    expect(before).toMatchObject({ aiPool: "auto", modelSelection: { instanceId: "codex" } });
    const answer = await fixture.desktopSwitch({ botId: first.bot.id, threadId: first.threadId, mode: "ask", modelSelection: before.modelSelection, updateBotDefault: false });
    expect(answer).toMatchObject({ type: "approval-trusted-mode-result", ok: true });
    expect(await taskOf(api, first.bot.id, first.threadId)).toMatchObject({ aiPool: "auto", modelSelection: before.modelSelection });
  });
}, 120_000);
