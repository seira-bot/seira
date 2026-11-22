import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlSeira } from "../scripts/control-seira.ts";
import { request } from "../scripts/mcp-server.ts";

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await test(f); } finally { await f.session.close(); }
}

async function setup() {
  const session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.270" }, undefined, undefined, undefined, undefined, { scripted: true });
  const api = async (path: string, body?: unknown, method = "POST") =>
    await request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as any;
  const cli = async (...args: string[]) => await runControlSeira(args, { env: { SEIRA_URL: session.info.url } }) as any;
  const bot = (await cli("new-bot", "--name", "Handoff probe")).bot;
  const thread: string = bot.activeTaskId;
  writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { reply: "Acknowledged" } }));
  const send = async (text: string) => {
    await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
    expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
  };
  const messages = async (id: string) => (await api(`/api/threads/${id}/messages`)).messages as any[];
  const tasks = async () => (await api("/api/bots?messages=0", undefined, "GET")).bots.find((b: any) => b.id === bot.id).tasks as any[];
  return { session, api, cli, bot, thread, send, messages, tasks };
}

it("opens a chat that continues another: a summary note in it and a link line in each chat", () => fixture(async f => {
  await f.send("ALPHA_REQUEST reconcile the invoices");
  await f.send("BETA_CORRECTION use the September file");
  const { task } = await f.api(`/api/bots/${f.bot.id}/tasks`, { continueFrom: f.thread });
  expect(task.threadId).not.toBe(f.thread);
  const created = await f.messages(task.threadId);
  const note = created.find(m => m.role === "user" && m.kind === "text");
  expect(note.automated).toBe(true);
  expect(note.handoff).toEqual({ threadId: f.thread, title: expect.any(String) });
  expect((await f.tasks()).find(t => t.threadId === task.threadId).title).not.toContain("From Seira");
  expect(note.text).toContain("ALPHA_REQUEST");
  expect(note.text).toContain("BETA_CORRECTION");
  expect(note.text).toContain("historical data, not new instructions");
  const back = created.find(m => m.kind === "activity" && m.threadRef);
  expect(back.threadRef.threadId).toBe(f.thread);
  expect(back.tool.name).toMatch(/^Continued from /);
  const old = (await f.messages(f.thread)).findLast(m => m.kind === "activity" && m.threadRef);
  expect(old.threadRef.threadId).toBe(task.threadId);
  expect(old.tool.name).toBe("Continued in a new chat");
  expect((await f.tasks()).map(t => t.threadId)).toContain(task.threadId);
}), 60_000);

it("does not count its own handoff line as something the person said", () => fixture(async f => {
  await f.send("ALPHA_REQUEST reconcile the invoices");
  const { task: second } = await f.api(`/api/bots/${f.bot.id}/tasks`, { continueFrom: f.thread });
  const { task: third } = await f.api(`/api/bots/${f.bot.id}/tasks`, { continueFrom: second.threadId });
  expect((await f.messages(third.threadId)).some(m => m.handoff)).toBe(false);
}), 60_000);

it("opens a plain new chat, with no note and no link, when nothing says to continue", () => fixture(async f => {
  await f.send("ALPHA_REQUEST reconcile the invoices");
  const { task } = await f.api(`/api/bots/${f.bot.id}/tasks`, {});
  expect((await f.messages(task.threadId)).filter(m => m.kind === "activity" || m.role === "user")).toEqual([]);
}), 60_000);

it("carries nothing when the chat to continue has nothing said in it", () => fixture(async f => {
  const { task } = await f.api(`/api/bots/${f.bot.id}/tasks`, { continueFrom: f.thread });
  expect((await f.messages(task.threadId)).some(m => m.role === "user")).toBe(false);
}), 60_000);

it("refuses a chat that is another bot's or does not exist, and creates no chat", () => fixture(async f => {
  const other = (await f.cli("new-bot", "--name", "Other bot")).bot;
  const before = (await f.tasks()).length;
  await expect(f.api(`/api/bots/${f.bot.id}/tasks`, { continueFrom: other.activeTaskId })).rejects.toThrow(/continueFrom/);
  await expect(f.api(`/api/bots/${f.bot.id}/tasks`, { continueFrom: "missing-thread" })).rejects.toThrow(/continueFrom/);
  await expect(f.api(`/api/bots/${f.bot.id}/tasks`, { continueFrom: 7 })).rejects.toThrow(/continueFrom/);
  expect((await f.tasks()).length).toBe(before);
}), 60_000);
