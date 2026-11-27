// Two real servers on this machine that belong to different owners. One makes an invite, the other uses it, and bots hand
// work across the guest link. Only each provider's planning is scripted. Nothing outside this machine is asked.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlSeira } from "../scripts/control-seira.ts";
import { decodeInvite, encodeInvite } from "./host/linked-servers-store.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { readJsonLines } from "./testing/json-lines.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;
type Json = Record<string, unknown>;
type Message = { kind?: string; role?: string; text?: string; card?: { requestId?: string; answered?: unknown; dismissed?: unknown; expired?: unknown };
  roomRequest?: { phase?: string }; tool?: { name?: string; output?: string } };
type LinkRow = { id: string; name: string; role: string; state: string; exposed: string[]; cap: string; bots: Array<{ id: string; name: string }> };
type Bot = { id: string; name: string; activeTaskId: string };

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
  return {
    url, dataDir, api, call,
    cli: (...args: string[]) => runControlSeira([...args, "--url", url]) as Promise<Json>,
    plan(botId: string, ...turns: unknown[]) { (plans[botId] ??= { turns: [] }).turns.push(...turns); writeFileSync(planPath, JSON.stringify(plans)); },
    providerTurns: (): Array<{ botId: string; permissionMode?: string; approval?: { behavior: string } }> => readJsonLines(`${planPath}.evidence.jsonl`),
    messages: async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as Message[],
    links: async () => (await api("GET", "/api/linked-servers")).servers as LinkRow[],
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
  };
}

/** The credential the joining server keeps in its own folder for the link. */
function joinerToken(dataDir: string): string | undefined {
  const root = join(dataDir, "linked-servers");
  for (const entry of existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }) : []) {
    if (!entry.isFile()) continue;
    const found = /lsk_[A-Za-z0-9_-]{43}/u.exec(readFileSync(join(entry.parentPath, entry.name), "utf8"));
    if (found) return found[0];
  }
  return undefined;
}

describe("a guest link between two servers", () => {
  let fixtures: Fixture[] = [];
  let head: ReturnType<typeof place>, branch: ReturnType<typeof place>;
  let atlas: Bot, writer: Bot;
  let token = "";
  let atlasAddress = "";

  beforeAll(async () => {
    fixtures = [await launchVerificationServer({ SEIRA_PUBLIC_URL: "https://head.example", SEIRA_TEST_LINKED_LOOPBACK: "1" }, undefined, undefined, undefined, undefined, { scripted: true }),
      await launchVerificationServer({ SEIRA_TEST_LINKED_LOOPBACK: "1" }, undefined, undefined, undefined, undefined, { scripted: true })];
    head = place(fixtures[0]!);
    branch = place(fixtures[1]!);
    await head.api("PATCH", "/api/config", { computerName: "Head office" });
    await branch.api("PATCH", "/api/config", { computerName: "Branch office" });
    atlas = (await head.cli("new-bot", "--name", "Atlas")).bot as Bot;
    writer = (await branch.cli("new-bot", "--name", "Writer")).bot as Bot;
    // Above the link's cap, so that work from the link runs at a lower level than the bot's own.
    await head.api("PATCH", `/api/bots/${atlas.id}`, { approvalMode: "full", applyToAllThreads: true });
  }, hostTimeout(120_000));

  afterAll(async () => { await Promise.all(fixtures.map((fixture) => fixture.close())); }, hostTimeout(60_000));

  it("joins with an invite, and each server lists the other by name", async () => {
    const made = await head.api("POST", "/api/linked-servers/invites");
    const invite = decodeInvite(String(made.invite));
    expect(invite, String(made.invite)).toMatchObject({ name: "Head office" });
    // The fixture has no secure public address, so the invite is pointed at the server's own loopback address.
    const joined = (await branch.api("POST", "/api/linked-servers/join", { invite: encodeInvite({ ...invite!, origin: head.url }) })).server as LinkRow;
    expect(joined).toMatchObject({ name: "Head office", role: "joiner" });
    await expect.poll(async () => (await head.links())[0], { timeout: 20_000 }).toMatchObject({ name: "Branch office", role: "inviter", state: "online" });
    await expect.poll(async () => (await branch.links())[0], { timeout: 20_000 }).toMatchObject({ name: "Head office", role: "joiner", state: "online" });
    expect(await head.links()).toHaveLength(1);
    expect(await branch.links()).toHaveLength(1);
  }, hostTimeout(60_000));

  it("shows no bot of a server before an admin exposes one", async () => {
    const [seen] = await branch.links();
    expect(seen!.bots).toEqual([]);
    expect((await head.links())[0]!.exposed).toEqual([]);
    await branch.api("GET", `/api/bots/link-00000000-${atlas.id}`, undefined, 404);
  });

  it("shows an exposed bot on the other server at once, with no restart", async () => {
    const [mine] = await head.links();
    const changed = (await head.api("PATCH", `/api/linked-servers/${mine!.id}`, { exposed: [atlas.id] })).server as LinkRow;
    expect(changed.exposed).toEqual([atlas.id]);
    await expect.poll(async () => (await branch.links())[0]!.bots, { timeout: 20_000 }).toEqual([{ id: expect.stringMatching(new RegExp(`^link-[0-9a-f]{8}-${atlas.id}$`, "u")), name: "Atlas" }]);
    atlasAddress = (await branch.links())[0]!.bots[0]!.id;
  }, hostTimeout(60_000));

  it("hands work to the exposed bot as outside work and returns its result to the asking thread", async () => {
    head.plan(atlas.id, { reply: "Atlas counted 42 orders." });
    branch.plan(writer.id,
      { steps: [{ tool: "list_bots", arguments: {} }, { tool: "coordinate_bots", arguments: { bot_ids: [atlasAddress], request_key: "count", message: "Count this week's orders." } }], reply: "Asked Atlas." },
      { reply: "Atlas says 42." });
    await branch.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Ask Atlas for this week's order count.");
    await expect.poll(() => head.providerTurns().find((turn) => turn.botId === atlas.id), { timeout: 30_000 }).toBeTruthy();
    expect((await branch.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "30")).status).toBe("settled");
    await expect.poll(async () => (await branch.messages(writer.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /42 orders/u.test(message.tool?.output ?? "")), { timeout: 20_000 }).toBe(true);
    const shown = await branch.messages(writer.activeTaskId);
    expect(shown.find((message) => message.roomRequest?.phase === "result")!.tool!.name).toContain("Atlas");
    expect(shown.filter((message) => message.kind === "text").at(-1)).toMatchObject({ role: "bot", text: "Atlas says 42." });

    const received = readHandoffs(head.dataDir).filter((node) => node.botId === atlas.id);
    expect(received).toHaveLength(1);
    expect(received[0]!.origin?.kind).toBe("outside");
    expect(received[0]!.text).toContain("Count this week's orders.");
  }, hostTimeout(90_000));

  it("asks for approval on the working server, at the link's level and not the bot's own", async () => {
    head.plan(atlas.id, { approve: { tool_name: "Bash", input: { command: "git push origin export" } }, reply: "Atlas pushed.", replyIfDenied: "Atlas did not push." });
    branch.plan(writer.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [atlasAddress], request_key: "push", message: "Push the export branch." } }], reply: "Asked Atlas to push." },
      { reply: "Atlas pushed it." });
    await branch.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Ask Atlas to push the export branch.");
    await expect.poll(async () => (await head.openApprovals(atlas.id)).length, { timeout: 30_000 }).toBe(1);
    expect(await branch.openApprovals(writer.id)).toEqual([]);
    const [card] = await head.openApprovals(atlas.id);
    const answered = await head.call("POST", `/api/threads/${card!.threadId}/respond`, { requestId: card!.requestId, behavior: "allow" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(async () => (await branch.messages(writer.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /Atlas pushed\./u.test(message.tool?.output ?? "")), { timeout: 30_000 }).toBe(true);
    expect((await branch.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "30")).status).toBe("settled");
    expect(head.providerTurns().filter((turn) => turn.botId === atlas.id).at(-1)?.approval?.behavior).toBe("allow");
    expect(await branch.openApprovals(writer.id)).toEqual([]);
  }, hostTimeout(120_000));

  it("keeps the link's credential to the link's own paths", async () => {
    const found = joinerToken(branch.dataDir);
    expect(found, "the joining server keeps the credential in its own link folder").toMatch(/^lsk_/u);
    token = found!;
    expect((await head.call("GET", "/api/bots", undefined, { token })).status).toBe(403);
    expect((await head.call("GET", "/api/linked-servers", undefined, { token })).status).toBe(403);
    const wrong = `lsk_${"A".repeat(43)}`;
    expect((await head.call("POST", "/api/linked-servers/sync", { ack: 0, frames: [], wait: 0 }, { token: wrong })).status).toBe(401);
    expect((await head.call("POST", "/api/linked-servers/sync", { ack: 0, frames: [], wait: 0 })).status).toBe(401);
    expect((await head.call("POST", "/api/linked-servers/sync", { ack: 0, frames: [], wait: 0 }, { token: "not-a-link-credential" })).status).toBe(401);
  });

  it("ends on both sides when the inviting server removes the link", async () => {
    const [mine] = await head.links();
    await head.api("DELETE", `/api/linked-servers/${mine!.id}`);
    expect(await head.links()).toEqual([]);
    await head.api("DELETE", `/api/linked-servers/${mine!.id}`, undefined, 404);
    await expect.poll(async () => (await branch.links())[0]?.state, { timeout: 30_000 }).toMatch(/^(ended|offline)$/u);
    expect((await head.call("POST", "/api/linked-servers/sync", { ack: 0, frames: [], wait: 0 }, { token })).status).toBe(401);
    expect((await branch.links())[0]!.bots).toEqual([]);
  }, hostTimeout(60_000));
});
