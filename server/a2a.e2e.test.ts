// Two real servers on this machine that belong to different owners, joined over A2A. One server calls the other server's
// bot as an A2A agent, and a plain JSON-RPC client calls it too. Only each provider's planning is scripted. Nothing
// outside this machine is asked.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlSeira } from "../scripts/control-seira.ts";
import { CHAINED } from "./host/linked-servers.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;
type Json = Record<string, any>;
type Message = { kind?: string; role?: string; text?: string; card?: { requestId?: string; answered?: unknown; dismissed?: unknown; expired?: unknown };
  roomRequest?: { phase?: string }; tool?: { name?: string; output?: string } };
type PeerRow = { id: string; kind: string; name: string; state: string; exposed: string[]; cap: string; bots: Array<{ id: string; name: string }> };
type Bot = { id: string; name: string; activeTaskId: string };

const NO_AGENT = { error: "There is no such agent here." };
const NOT_VALID = { error: "The token is not valid." };
const TOKEN = /^lsa_[A-Za-z0-9_-]{43}$/u;

function place(fixture: Fixture) {
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: unknown[] }> = {};
  const call = async (method: string, path: string, body?: unknown, options: { token?: string } = {}) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as Json };
  };
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const answer = await call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBe(status);
    return answer.body;
  };
  /** A request as a plain A2A client makes it: a bearer token and no browser origin. */
  const rpc = async (token: string, botId: string, method: string, params: unknown) => {
    const response = await fetch(`${url}/api/a2a/${botId}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as Json };
  };
  return {
    url, dataDir, api, call, rpc,
    cli: (...args: string[]) => runControlSeira([...args, "--url", url]) as Promise<Json>,
    plan(botId: string, ...turns: unknown[]) { (plans[botId] ??= { turns: [] }).turns.push(...turns); writeFileSync(planPath, JSON.stringify(plans)); },
    providerTurns: (): Array<{ botId: string; approval?: { behavior: string } }> => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    messages: async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Message[],
    peers: async () => ((await api("GET", "/api/linked-servers")).servers as PeerRow[]),
    /** Every message of every conversation of this bot. */
    async messagesOf(botId: string): Promise<Message[]> {
      const bots = (await api("GET", "/api/bots?messages=0")).bots as Array<{ id: string; tasks?: Array<{ threadId: string }> }>;
      const found: Message[] = [];
      for (const task of bots.find((bot) => bot.id === botId)?.tasks ?? []) found.push(...await this.messages(task.threadId));
      return found;
    },
    /** Approval cards that wait for an answer in any conversation of this bot. */
    async openApprovals(botId: string) {
      const bots = (await api("GET", "/api/bots?messages=0")).bots as Array<{ id: string; tasks?: Array<{ threadId: string }> }>;
      const found: Array<{ threadId: string; requestId: string }> = [];
      for (const task of bots.find((bot) => bot.id === botId)?.tasks ?? []) {
        for (const message of await this.messages(task.threadId)) {
          const card = message.card;
          if (message.kind === "options" && card?.requestId && !card.answered && !card.dismissed && !card.expired) found.push({ threadId: task.threadId, requestId: card.requestId });
        }
      }
      return found;
    },
    /** The activity record, as text. */
    async activity(): Promise<string> { return JSON.stringify((await api("GET", "/api/admin-activity?what=all&limit=5000")).entries); },
  };
}

const message = (text: string, messageId: string) => ({ message: { messageId, role: "ROLE_USER", parts: [{ text }] }, configuration: { returnImmediately: true } });
const stateOf = (body: Json): string | undefined => (body.result?.task ?? body.result)?.status?.state;
const approveAndPush = (reply: string) => ({ approve: { tool_name: "Bash", input: { command: "git push origin export" } }, reply, replyIfDenied: "Not pushed." });

describe("an A2A agent between two servers", () => {
  let fixtures: Fixture[] = [];
  let far: ReturnType<typeof place>, near: ReturnType<typeof place>;
  let atlas: Bot, vault: Bot, writer: Bot;
  let token = "", farPeer = "", agentAddress = "";

  beforeAll(async () => {
    const env = { SEIRA_TEST_A2A_LOOPBACK: "1" };
    fixtures = [await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true }),
      await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true })];
    far = place(fixtures[0]!);
    near = place(fixtures[1]!);
    await far.api("PATCH", "/api/config", { computerName: "Far office" });
    await near.api("PATCH", "/api/config", { computerName: "Near office" });
    atlas = (await far.cli("new-bot", "--name", "Atlas")).bot as Bot;
    vault = (await far.cli("new-bot", "--name", "Vault")).bot as Bot;
    writer = (await near.cli("new-bot", "--name", "Writer")).bot as Bot;
    // Above the cap of the agent, so that its work runs at a lower level than the bot's own.
    await far.api("PATCH", `/api/bots/${atlas.id}`, { approvalMode: "full", applyToAllThreads: true });
  }, hostTimeout(120_000));

  afterAll(async () => { await Promise.all(fixtures.map((fixture) => fixture.close())); }, hostTimeout(60_000));

  it("pairs: the far server shows a token once and a card address, and the near server then lists the agent as a teammate", async () => {
    const made = await far.api("POST", "/api/linked-servers/a2a", { name: "Near office agent", inbound: true, exposed: [atlas.id] });
    token = String(made.token);
    farPeer = String((made.server as PeerRow).id);
    expect(token).toMatch(TOKEN);
    const urls = made.urls as Array<{ bot: string; url: string }>;
    expect(urls).toEqual([{ bot: atlas.id, url: `${far.url}/api/a2a/${atlas.id}/.well-known/agent-card.json` }]);
    expect(made.server).toMatchObject({ kind: "a2a", cap: "ask", exposed: [atlas.id] });
    const added = await near.api("POST", "/api/linked-servers/a2a", { name: "Far agent", url: urls[0]!.url, token, inbound: false });
    expect(added.server).toMatchObject({ kind: "a2a", name: "Far agent", outbound: { hasToken: true }, inbound: null });
    await expect.poll(async () => (await near.peers())[0], { timeout: 30_000 }).toMatchObject({ state: "online", bots: [{ name: "Far agent" }] });
    agentAddress = (await near.peers())[0]!.bots[0]!.id;
    expect(agentAddress).toMatch(/^link-[0-9a-f]{8}-agent$/u);
  }, hostTimeout(60_000));

  it("answers a plain client with the card of an exposed bot, and refuses a wrong token and a bot that is not exposed", async () => {
    const card = await fetch(`${far.url}/api/a2a/${atlas.id}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${token}` } });
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({
      name: "Atlas", supportedInterfaces: [{ url: `${far.url}/api/a2a/${atlas.id}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false }, skills: [{ id: atlas.id }],
    });
    const cardOf = (botId: string, bearer: string) => fetch(`${far.url}/api/a2a/${botId}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${bearer}` } });
    const wrong = await cardOf(atlas.id, `lsa_${"A".repeat(43)}`);
    expect([wrong.status, await wrong.json()]).toEqual([401, NOT_VALID]);
    const none = await fetch(`${far.url}/api/a2a/${atlas.id}/.well-known/agent-card.json`);
    expect(none.status).toBe(401);
    const hidden = await cardOf(vault.id, token), missing = await cardOf("ghost", token);
    expect([hidden.status, await hidden.json()]).toEqual([404, NO_AGENT]);
    expect([missing.status, await missing.json()]).toEqual([404, NO_AGENT]);
    expect((await fetch(`${far.url}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await far.rpc(token, vault.id, "GetTask", { id: "x" })).status).toBe(404);
  });

  it("refuses the agent's token on every path that is not an A2A path", async () => {
    expect((await far.call("GET", "/api/linked-servers", undefined, { token })).status).toBe(403);
    expect((await far.call("GET", "/api/bots", undefined, { token })).status).toBe(403);
    expect((await far.call("POST", "/api/linked-servers/a2a", { name: "Other", inbound: true }, { token })).status).toBe(403);
    expect((await far.call("POST", "/api/linked-servers/sync", { ack: 0, frames: [], wait: 0 }, { token })).status).toBe(401);
    expect((await far.rpc("lsk_".padEnd(47, "A"), atlas.id, "GetTask", { id: "x" })).status).toBe(401);
  });

  it("shows the approval card on the far server under the cap ask, and the caller sees working until a person answers (AC-28)", async () => {
    expect((await far.peers()).find((one) => one.id === farPeer)!.cap).toBe("ask");
    far.plan(atlas.id, approveAndPush("Atlas pushed."));
    const sent = await far.rpc(token, atlas.id, "SendMessage", message("Push the export branch.", "m-ask"));
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const taskId = String(sent.body.result.task.id);
    await expect.poll(async () => (await far.openApprovals(atlas.id)).length, { timeout: 30_000 }).toBe(1);
    for (let look = 0; look < 3; look += 1) {
      expect(stateOf((await far.rpc(token, atlas.id, "GetTask", { id: taskId })).body)).toBe("TASK_STATE_WORKING");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const [card] = await far.openApprovals(atlas.id);
    const answered = await far.call("POST", `/api/threads/${card!.threadId}/respond`, { requestId: card!.requestId, behavior: "allow" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(async () => stateOf((await far.rpc(token, atlas.id, "GetTask", { id: taskId })).body), { timeout: 30_000 }).toBe("TASK_STATE_COMPLETED");
    const done = (await far.rpc(token, atlas.id, "GetTask", { id: taskId })).body.result;
    expect(done.artifacts[0].parts[0].text).toContain("Atlas pushed.");
    expect(far.providerTurns().filter((turn) => turn.botId === atlas.id).at(-1)?.approval?.behavior).toBe("allow");
  }, hostTimeout(120_000));

  it("stops a second task when the caller cancels it, and refuses to cancel it twice", async () => {
    far.plan(atlas.id, approveAndPush("Atlas pushed again."));
    const sent = await far.rpc(token, atlas.id, "SendMessage", message("Push it once more.", "m-cancel"));
    const taskId = String(sent.body.result.task.id);
    await expect.poll(async () => (await far.openApprovals(atlas.id)).length, { timeout: 30_000 }).toBe(1);
    const stopped = await far.rpc(token, atlas.id, "CancelTask", { id: taskId });
    expect(stateOf(stopped.body), JSON.stringify(stopped.body)).toBe("TASK_STATE_CANCELED");
    await expect.poll(async () => stateOf((await far.rpc(token, atlas.id, "GetTask", { id: taskId })).body), { timeout: 20_000 }).toBe("TASK_STATE_CANCELED");
    expect((await far.rpc(token, atlas.id, "CancelTask", { id: taskId })).body.error.code).toBe(-32002);
  }, hostTimeout(90_000));

  it("hands work from a bot on the near server to the agent, and the result returns to the asking thread, with no token in either activity record (AC-05)", async () => {
    await far.api("PATCH", `/api/linked-servers/${farPeer}`, { cap: "auto" });
    far.plan(atlas.id, { reply: "Atlas counted 42 orders." });
    near.plan(writer.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [agentAddress], request_key: "count", message: "Count this week's orders." } }], reply: "Asked Atlas." },
      { reply: "Atlas says 42." });
    await near.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Ask Atlas for this week's order count.");
    await expect.poll(async () => (await near.messages(writer.activeTaskId)).some((one) => one.roomRequest?.phase === "result" && /42 orders/u.test(one.tool?.output ?? "")), { timeout: 60_000 }).toBe(true);
    expect((await near.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const shown = await near.messages(writer.activeTaskId);
    expect(shown.find((one) => one.roomRequest?.phase === "result")!.tool!.name).toContain("Far agent");
    expect(shown.filter((one) => one.kind === "text").at(-1)).toMatchObject({ role: "bot", text: "Atlas says 42." });

    const received = readHandoffs(far.dataDir).filter((node) => node.botId === atlas.id && node.text.includes("Count this week's orders."));
    expect(received).toHaveLength(1);
    expect(received[0]!.origin?.kind).toBe("outside");

    await expect.poll(async () => (await far.activity()).includes("Near office agent"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await near.activity()).includes("Far agent"), { timeout: 20_000 }).toBe(true);
    for (const side of [far, near]) {
      const text = await side.activity();
      expect(text).toContain("linked-server");
      expect(text).not.toContain(token);
      expect(text).not.toMatch(/lsa_[A-Za-z0-9_-]{20}/u);
    }
  }, hostTimeout(150_000));

  it("keeps work that the agent started from going on to another A2A agent of the far server (AC-29)", async () => {
    const made = await near.api("POST", "/api/linked-servers/a2a", { name: "Far caller", inbound: true, exposed: [writer.id] });
    const urls = made.urls as Array<{ url: string }>;
    await far.api("POST", "/api/linked-servers/a2a", { name: "Near writer", url: urls[0]!.url, token: String(made.token), inbound: false });
    let other = "";
    await expect.poll(async () => { other = (await far.peers()).find((one) => one.name === "Near writer")?.bots[0]?.id ?? ""; return other; }, { timeout: 30_000 }).toMatch(/^link-/u);

    far.plan(atlas.id, { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [other], request_key: "hop", message: "Pass this on." } }], reply: "Tried to pass it on." });
    const sent = await far.rpc(token, atlas.id, "SendMessage", message("Pass this on to the writer.", "m-hop"));
    const taskId = String(sent.body.result.task.id);
    await expect.poll(async () => stateOf((await far.rpc(token, atlas.id, "GetTask", { id: taskId })).body), { timeout: 60_000 }).toMatch(/^TASK_STATE_(COMPLETED|FAILED)$/u);
    expect(JSON.stringify(await far.messagesOf(atlas.id))).toContain(CHAINED);
    expect(readHandoffs(far.dataDir).some((node) => node.botId === other)).toBe(false);
    expect(readHandoffs(near.dataDir).some((node) => node.botId === writer.id && node.text.includes("Pass this on."))).toBe(false);
  }, hostTimeout(120_000));

  it("refuses the old token at once after a new one is made, and the new one works", async () => {
    const rotated = await far.api("POST", `/api/linked-servers/${farPeer}/token`);
    const fresh = String(rotated.token);
    expect(fresh).toMatch(TOKEN);
    expect(fresh).not.toBe(token);
    expect((await far.rpc(token, atlas.id, "GetTask", { id: "x" })).status).toBe(401);
    expect((await far.rpc(fresh, atlas.id, "GetTask", { id: "x" })).body.error.code).toBe(-32001);
    token = fresh;
  });

  it("answers 401 to the old token and stops the work of the agent once the far server removes it (AC-40)", async () => {
    await far.api("PATCH", `/api/linked-servers/${farPeer}`, { cap: "ask" });
    far.plan(atlas.id, approveAndPush("Atlas pushed a third time."));
    const sent = await far.rpc(token, atlas.id, "SendMessage", message("Push it a third time.", "m-removed"));
    const taskId = String(sent.body.result.task.id);
    await expect.poll(async () => (await far.openApprovals(atlas.id)).length, { timeout: 30_000 }).toBe(1);
    const open = readHandoffs(far.dataDir).filter((node) => node.botId === atlas.id && node.text.includes("Push it a third time."));
    expect(open).toHaveLength(1);

    await far.api("DELETE", `/api/linked-servers/${farPeer}`);
    await far.api("DELETE", `/api/linked-servers/${farPeer}`, undefined, 404);
    expect((await far.rpc(token, atlas.id, "GetTask", { id: taskId })).status).toBe(401);
    const card = await fetch(`${far.url}/api/a2a/${atlas.id}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${token}` } });
    expect(card.status).toBe(401);
    expect((await far.peers()).some((one) => one.id === farPeer)).toBe(false);
    await expect.poll(() => readHandoffs(far.dataDir).find((node) => node.id === open[0]!.id)?.status, { timeout: 30_000 }).toMatch(/^(cancelled|failed)$/u);
  }, hostTimeout(120_000));
});
