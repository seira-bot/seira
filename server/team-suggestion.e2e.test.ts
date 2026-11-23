// Seira suggests a team: the question, the AI's suggest_team call through the mounted Chief MCP proxy, the card that
// creates nothing, then Create team or Skip, a newer card replacing an older one, and a member who may not create it.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { launchVerificationServer, runControlSeira } from "../scripts/control-seira.ts";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Bot = { id: string; name: string; threadId?: string; mainThreadId?: string };
type Line = { id: string; role: string; text?: string; teamAsk?: true; teamRequest?: true; teamSuggestion?: { state: string; document: { package: { agents: Array<{ key: string; name: string }> } } }; teamIntro?: { department: string; bots: Array<{ name: string; job: string }>; firstTask?: string } };
type Mounted = { command: string; args: string[]; env: Record<string, string> };

const BOTS = [
  { name: "Baker", role: "Orders", job: "Tracks the daily orders." },
  { name: "Books", role: "Bookkeeper", job: "Keeps the weekly books." },
  { name: "Post", role: "Social", job: "Writes the weekly post." },
];
const SUGGESTION = { department: "Bakery", summary: "A small team for a bakery.", bots: BOTS, group_chats: [{ name: "Morning huddle", members: ["Baker", "Books", "Post"] }], first_task: "Plan this week's orders" };

it("suggests a team, creates only what is kept, and honors Skip and a newer card", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const proxies: ChildProcess[] = [];
  const control = (args: string[]) => runControlSeira([...args, "--url", fixture.info.url]);
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  };
  const lines = async (threadId: string) => (await call<{ messages: Line[] }>("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages;
  const botNames = async () => (await call<{ bots: Bot[] }>("GET", "/api/bots?messages=0")).body.bots.map((bot) => bot.name).sort();
  try {
    const { bot: chief } = await control(["new-bot", "--name", "Fixture Chief"]) as { bot: Bot };
    await call("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const listed = (await call<{ bots: Bot[] }>("GET", "/api/bots?messages=0")).body.bots.find((bot) => bot.id === chief.id)!;
    const thread = (listed.mainThreadId ?? listed.threadId)!;
    const ask = await call<{ message: Line }>("POST", `/api/bots/${chief.id}/team-ask`, { threadId: thread });
    expect(ask.status, JSON.stringify([ask.body, chief])).toBe(200);
    expect(ask.body.message.teamAsk).toBe(true);

    rmSync(fixture.fixtureDumpPath, { force: true });
    await call("POST", `/api/bots/${chief.id}/messages`, { text: "I run a small bakery", threadId: thread });
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    expect((await lines(thread)).find((line) => line.text === "I run a small bakery")?.teamRequest).toBe(true);
    const { mcpConfig } = z.object({ mcpConfig: z.object({ mcpServers: z.object({ agents: z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }) }) }) }).parse(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    const mounted: Mounted = mcpConfig.mcpServers.agents;
    const proxy = spawn(mounted.command, mounted.args, { cwd: process.cwd(), env: { ...mounted.env, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
    proxies.push(proxy);
    const pending = new Map<number, (result: unknown) => void>();
    let nextId = 0;
    createInterface({ input: proxy.stdout! }).on("line", (text) => { const reply = JSON.parse(text) as { id: number; result: unknown }; pending.get(reply.id)?.(reply.result); });
    const rpc = <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`${method} did not answer`)), 10_000);
      pending.set(id, (result) => { clearTimeout(timer); resolve(result as T); });
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const suggest = async (args: Record<string, unknown>) => (await rpc<{ isError?: boolean }>("tools/call", { name: "suggest_team", arguments: args }));
    const cards = async () => (await lines(thread)).filter((line) => line.teamSuggestion);

    expect((await rpc<{ tools: Array<{ name: string }> }>("tools/list")).tools.map((tool) => tool.name)).toContain("suggest_team");
    const before = await botNames();

    // AC-04: a suggestion is a card and creates no bot.
    expect((await suggest(SUGGESTION)).isError).toBeFalsy();
    expect(await botNames()).toEqual(before);
    const [first] = await cards();
    expect(first?.teamSuggestion?.state).toBe("open");

    // AC-07: a newer suggestion replaces the open one.
    expect((await suggest({ ...SUGGESTION, department: "Bakery two" })).isError).toBeFalsy();
    const [older, newer] = await cards();
    expect(older?.teamSuggestion?.state).toBe("replaced");
    expect(newer?.teamSuggestion?.state).toBe("open");
    expect((await call("POST", `/api/teams/suggestion/${older!.id}`, { threadId: thread, keep: [] })).status).toBe(409);

    // AC-06: Skip creates nothing.
    expect((await call("POST", `/api/teams/suggestion/${newer!.id}/skip`, { threadId: thread, keep: [] })).status).toBe(200);
    expect((await cards()).at(-1)?.teamSuggestion?.state).toBe("skipped");
    expect(await botNames()).toEqual(before);

    // AC-05 and AC-08: Create team makes only the kept, renamed bots, and Seira introduces them.
    await suggest(SUGGESTION);
    const open = (await cards()).at(-1)!;
    const keys = open.teamSuggestion!.document.package.agents.map((agent) => agent.key);
    const created = await call<{ bots: Array<{ name: string }>; groups?: unknown[] }>("POST", `/api/teams/suggestion/${open.id}`, {
      threadId: thread, keep: [keys[0], keys[1]], names: { [keys[1]!]: "Ledger" }, department: "Corner Bakery",
    });
    expect(created.status).toBe(201);
    expect(created.body.bots.map((entry) => entry.name)).toEqual(["Baker", "Ledger"]);
    expect(await botNames()).toEqual([...before, "Baker", "Ledger"].sort());
    const after = await lines(thread);
    expect(after.find((line) => line.id === open.id)?.teamSuggestion?.state).toBe("created");
    const intro = after.find((line) => line.teamIntro)?.teamIntro;
    expect(intro).toMatchObject({ department: "Corner Bakery", firstTask: "Plan this week's orders" });
    expect(intro?.bots.map((entry) => entry.job)).toEqual(["Tracks the daily orders.", "Keeps the weekly books."]);
    expect((await call("POST", `/api/teams/suggestion/${open.id}`, { threadId: thread, keep: [] })).status).toBe(409);
  } finally {
    for (const proxy of proxies) await waitForExit(proxy, { signal: "SIGTERM" });
    await fixture.close();
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 90_000);

let fx: CloudSendFixture, team: CloudTeamFixture;
beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-9", name: "Acme", engine: "" } });
  team = fx.team!;
}, hostTimeout(120_000));
afterAll(async () => {
  await fx?.close();
});

it("refuses a member and creates nothing (AC-09)", async () => {
  const member = (await team.pair({ email: "ada@acme.test", role: "member" })).token!;
  const count = async () => ((await team.as(member, "GET", "/api/bots?messages=0")).body.bots as unknown[]).length;
  const before = await count();
  expect((await team.as(member, "POST", `/api/bots/${(await team.as(member, "GET", "/api/bots?messages=0")).body.bots[0]?.id ?? "none"}/team-ask`, { threadId: "some-thread" })).status).toBe(403);
  const answer = await team.as(member, "POST", "/api/teams/suggestion/some-message", { threadId: "some-thread", keep: [] });
  expect(answer.status).toBe(403);
  expect((await team.as(member, "POST", "/api/teams/suggestion/some-message/skip", { threadId: "some-thread", keep: [] })).status).toBe(403);
  expect(await count()).toBe(before);
}, hostTimeout(60_000));
