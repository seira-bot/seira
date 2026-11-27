// A real server with email sign-in on (a mail server address on this machine; no mail is sent) and the real injected
// agents proxy; only the provider's planning is scripted. A bot on Full access asks to invite a person: a card waits, an
// admin's phone applies it, a phone with no admin rights cannot, and Undo takes the person out again.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-seira.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readRegistry, writeRegistry } from "./testing/registry.ts";

const SMTP = { SEIRA_SIGNIN_SMTP_URL: "smtp://127.0.0.1:9" };
const NEWCOMER = "new@corp.test";
let fixture: VerificationServer;
let child: ChildProcess | undefined;
let url: string;
let planPath: string;
let bot: { id: string; threadId: string };
let ownerDevice: string;
let clientDevice: string;
const plans: Record<string, { script: unknown[] }> = {};

const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(status);
  return result;
};
const signIn = async () => (await api("GET", "/api/config", undefined, 200, ownerDevice)).signIn;
const grants = async () => (await api("GET", "/api/department-access", undefined, 200, ownerDevice)).people as Record<string, { departments: Array<{ name: string; level: string }>; bots: unknown[] }>;
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const settingCards = async () => (await messages(bot.threadId)).filter((message) => message.card?.appSettingRequest);
const newest = async () => (await settingCards()).filter((one) => one.card.appSettingRequest.settingId === "people.signIn").at(-1)?.card;
const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
  ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const results = (turn: any) => turn.evidence.filter((entry: any) => entry.step).map((entry: any) => ({
  isError: Boolean(entry.response.error || entry.response.result?.isError),
  text: (entry.response.result?.content ?? []).map((part: any) => part.text).join("\n") || JSON.stringify(entry.response.error ?? null),
}));
const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.every((one: any) => !one.busy), { timeout: 20_000 }).toBe(true);
const invite = (value: unknown) => ({ tool: "app_settings", arguments: { action: "set", id: "people.signIn", value: JSON.stringify(value) }, expectError: false });
const start = async (key: string, steps: unknown[]) => {
  plans[bot.id]!.script.push({ key, match: [key], steps, reply: `Done: ${key}`, timeoutMs: 20_000 });
  writeFileSync(planPath, JSON.stringify(plans));
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `${key}: please change who signs in.` }, 202);
};
/** The turn Seira resumes the bot with once a card is answered: its own plan, so the next request does not wait behind it. */
const hears = (key: string, heard: string) => {
  plans[bot.id]!.script.push({ key, match: [heard], steps: [], reply: `Done: ${key}`, timeoutMs: 20_000 });
  writeFileSync(planPath, JSON.stringify(plans));
};
const finished = async (key: string) => {
  let turn: any;
  await expect.poll(() => (turn = providerTurns().find((candidate) => candidate.planKey === key)) !== undefined, { timeout: 30_000 }).toBe(true);
  await idle();
  return turn;
};
const respond = (requestId: string, token: string, status = 200) => api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" }, status, token);

beforeAll(async () => {
  fixture = await launchVerificationServer(SMTP, undefined, undefined, undefined, undefined, { scripted: true });
  ({ url } = fixture.info);
  const dataDir = fixture.info.dataDir;
  planPath = join(dataDir, "room-plan.json");
  const created = (await api("POST", "/api/bots", { name: "Inviter" }, 201)).bot;
  bot = { id: created.id, threadId: created.threadId };
  plans[bot.id] = { script: [] };
  writeFileSync(planPath, JSON.stringify(plans));

  // Fixture setup, not a production grant: the stopped fixture's own bot is put on Full access on disk.
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const saved = readRegistry(dataDir).bots;
  const inviter = saved.find((one: any) => one.id === bot.id);
  inviter.approvalMode = "full"; inviter.autoApprove = false;
  for (const task of inviter.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
  writeRegistry(dataDir, { bots: saved });
  const env = verificationServerEnvironment(SMTP, dataDir, Number(new URL(url).port));
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, verificationServerArgs(env), { cwd: join(import.meta.dirname, ".."), env, stdio: ["ignore", log, log] });
  closeSync(log);
  for (const deadline = Date.now() + 20_000; ;) {
    if (child.exitCode !== null) throw new Error(`restarted server exited; see ${fixture.info.logPath}`);
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`restarted server did not start; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const opened = await api("POST", "/api/auth/pairing", { label: "Owner phone", scopes: ["admin", "client"] });
  ownerDevice = (await api("POST", "/api/auth/pair", { code: opened.code })).token;
  const second = await api("POST", "/api/auth/pairing", { label: "Second device", scopes: ["client"] });
  clientDevice = (await api("POST", "/api/auth/pair", { code: second.code })).token;
  await api("PUT", "/api/config", { signIn: { admins: ["owner@corp.test"], members: [] } }, 200, ownerDevice);
}, 90_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("a server with a mail server address on this machine says it signs people in by email", async () => {
  const descriptor = await (await fetch(`${url}/.well-known/seira/environment`, { signal: AbortSignal.timeout(10_000) })).json() as any;
  expect(descriptor.capabilities.emailSignIn).toBe(true);
});

it("a bot's invite waits on a card and changes nothing, a phone without admin rights cannot apply it, and the owner's phone applies it", async () => {
  hears("INVITE-HEARD", "The user applied the change: People who sign in");
  await start("INVITE", [invite({ email: NEWCOMER, sees: { departments: ["General"] } })]);
  const turn = await finished("INVITE");
  const [asked] = results(turn);
  expect(asked).toMatchObject({ isError: false, text: expect.stringMatching(/^A card asking the user to apply this is in the conversation: .*Nothing has changed yet\./) });
  const card = await newest();
  expect(card).toMatchObject({ title: "Change People who sign in?", options: ["Apply", "Not now"],
    appSettingRequest: { settingId: "people.signIn", consequence: `${NEWCOMER} can sign in and sees only: General.` } });
  expect(card.appSettingRequest.after).toContain(`Invite ${NEWCOMER} as user, sees only General`);
  expect(await signIn()).toEqual({ admins: ["owner@corp.test"], members: [] });
  expect(await grants()).toEqual({});

  expect(await respond(card.requestId, clientDevice, 403)).toMatchObject({ error: expect.stringContaining("Only the owner applies this change") });
  expect(await signIn()).toEqual({ admins: ["owner@corp.test"], members: [] });
  expect(await grants()).toEqual({});

  expect(await respond(card.requestId, ownerDevice)).toMatchObject({ ok: true });
  await finished("INVITE-HEARD");
  expect((await signIn()).members).toEqual([NEWCOMER]);
  expect((await grants())[NEWCOMER]).toEqual({ departments: [{ name: "", level: "chat" }], bots: [] });
}, 90_000);

it("Undo from the owner's phone takes the person and their access out again", async () => {
  const card = await newest();
  expect(await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: card.requestId }, 200, ownerDevice)).toMatchObject({ ok: true, undone: true });
  expect((await signIn()).members).toEqual([]);
  expect(await grants()).toEqual({});
}, 30_000);

it("a bot cannot make a whole @domain an admin: the set is refused and posts no card", async () => {
  const before = (await settingCards()).length;
  await start("DOMAIN-ADMIN", [{ ...invite({ email: "@corp.test", role: "admin" }), expectError: true }]);
  const [refused] = results(await finished("DOMAIN-ADMIN"));
  expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/^A bot cannot make a whole @domain an admin\./) });
  expect((await settingCards()).length).toBe(before);
  expect(await signIn()).toEqual({ admins: ["owner@corp.test"], members: [] });
}, 60_000);
