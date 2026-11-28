import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppTriggerRequestService } from "./app-trigger-requests.ts";
import { appEventCatalog } from "./app-event-catalog.ts";
import { eventCount } from "./app-events.ts";
import { brokerClient } from "./app-trigger-broker.ts";
import { AppTriggerManager, type AppTriggerManagerOptions } from "./app-triggers.ts";
import { RoutineManager } from "./routines.ts";
import { WebhookManager } from "./webhooks.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";

let dir = "";
let broker: BrokerFake;
let owner: { id: string; token: string; userId: string };
let gmail = "";
let routines: RoutineManager;
let connected: Record<string, { connected: boolean; accounts: Array<{ id: string; alias?: string; status: string }> }>;
let failNextEnqueue: "before-save" | "after-save" | null = null;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "seira-app-triggers-"));
  broker = await startBrokerFake();
  owner = await broker.install();
  gmail = broker.account(owner.userId, "gmail", "sales");
  connected = { gmail: { connected: true, accounts: [{ id: gmail, alias: "sales", status: "ACTIVE" }] } };
  // Busy, so runs stay queued: what a burst or a catch-up meets while the bot works on the first one.
  routines = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "busy", createTask: () => ({ threadId: "thread-run" }), startTurn: async () => {} });
  failNextEnqueue = null;
});

afterEach(async () => {
  routines.close();
  await broker.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function manager(overrides: Partial<AppTriggerManagerOptions> = {}) {
  return new AppTriggerManager({
    file: join(dir, "app-triggers.json"),
    broker: brokerClient(() => ({ url: broker.url, token: owner.token })),
    service: () => ({ available: true }),
    connectedApps: async () => connected,
    botState: () => "ready",
    runs: {
      enqueue: (input) => {
        const failure = failNextEnqueue;
        failNextEnqueue = null;
        if (failure === "before-save") throw new Error("disk full");
        const run = routines.enqueueWebhook(input);
        if (failure === "after-save") throw new Error("crashed after the run was saved");
        return run;
      },
      merge: (triggerId, eventId, sameConversation, merge) => routines.mergeIntoQueuedRun(triggerId, eventId, sameConversation, merge),
      receipt: (triggerId, eventId) => routines.webhookRunReceipt(triggerId, eventId),
      pending: (triggerId) => routines.activeWebhookRunCount(triggerId),
      cancelQueued: (triggerId, message) => routines.cancelQueuedWebhook(triggerId, message),
    },
    log: () => {},
    ...overrides,
  });
}

// The mark is stored and served, but is not part of the shared phone contract.
const placeLost = (row: object | null | undefined) => (row as { placeLost?: true } | null | undefined)?.placeLost;
const runsOf = (triggerId: string) => routines.listRuns().filter((run) => run.routineId === triggerId);
const drain = async (triggers: AppTriggerManager) => { while (await triggers.pollOnce(undefined, 0) > 0) { /* until the queue is empty */ } };

async function gmailTrigger(triggers: AppTriggerManager, filter = { from: "acme.com", subject: "order" }) {
  return triggers.create({ botId: "bot-1", name: "Order replies", prompt: "Draft a reply with the order status.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter });
}

describe("AppTriggerManager", () => {
  it("rejects a concurrent duplicate before one event can queue two runs", async () => {
    const client = brokerClient(() => ({ url: broker.url, token: owner.token }));
    const type = await client.triggerType("GMAIL_NEW_GMAIL_MESSAGE");
    vi.spyOn(client, "triggerType").mockResolvedValue(type);
    const triggers = manager({ broker: client });
    const results = await Promise.allSettled([gmailTrigger(triggers), gmailTrigger(triggers)]);
    const created = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(created).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { status: 409 } }]);
    expect(triggers.list()).toHaveLength(1);
    expect(broker.harness.composio.instances.size).toBe(1);
    await broker.deliver(created[0]!.remote.triggerId!, { subject: "Order #7", sender: "person@acme.com" }, "msg_concurrent");
    await triggers.pollOnce(undefined, 0);
    expect(routines.listRuns()).toHaveLength(1);
  });

  it("refuses a bot replacement when a direct edit adds protected instructions during its network wait", async () => {
    const client = brokerClient(() => ({ url: broker.url, token: owner.token }));
    const triggers = manager({ broker: client });
    const saved = await gmailTrigger(triggers);
    const store = { messagesFor: () => [], appendMessage: vi.fn(() => ({ id: "message-1" })), patchMessage: vi.fn() };
    const service = new AppTriggerRequestService({ triggers, store, botName: () => "Fixture" });
    const type = await client.triggerType(saved.event);
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(client, "triggerType").mockImplementationOnce(async () => { entered(); await resume; return type; });
    const outcome = service.submit({ botId: saved.botId, threadId: "thread-a", operation: {
      action: "update", triggerId: saved.id, changes: { name: "Must not apply", instructions: "Bot replacement", filter: { from: "changed.example" } },
    } }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await blocked;
    const protectedPrompt = "Use token=fixture-private-value.";
    let before!: ReturnType<AppTriggerManager["list"]>;
    let remote!: Array<unknown>;
    try {
      await triggers.update(saved.id, { prompt: protectedPrompt });
      before = structuredClone(triggers.list());
      remote = structuredClone([...broker.harness.composio.instances.entries()]);
    } finally { release(); }
    expect((await outcome).error).toMatchObject({ status: 409 });
    expect(triggers.list()).toEqual(before);
    expect([...broker.harness.composio.instances.entries()]).toEqual(remote);
    expect(store.appendMessage).not.toHaveBeenCalled();
  });

  it("refuses a bot replacement queued behind a direct edit that stores protected instructions", async () => {
    const client = brokerClient(() => ({ url: broker.url, token: owner.token }));
    const triggers = manager({ broker: client });
    const saved = await gmailTrigger(triggers);
    const store = { messagesFor: () => [], appendMessage: vi.fn(() => ({ id: "message-1" })), patchMessage: vi.fn() };
    const service = new AppTriggerRequestService({ triggers, store, botName: () => "Fixture" });
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const setEnabled = client.setEnabled.bind(client);
    vi.spyOn(client, "setEnabled").mockImplementationOnce(async (...args) => { entered(); await resume; await setEnabled(...args); });
    const holding = triggers.update(saved.id, { name: "Holding update" });
    await blocked;
    const protectedPrompt = "Use token=fixture-private-value.";
    const manual = triggers.update(saved.id, { prompt: protectedPrompt });
    const outcome = service.submit({ botId: saved.botId, threadId: "thread-a", operation: {
      action: "update", triggerId: saved.id, changes: { name: "Must not apply", instructions: "Bot replacement" },
    } }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    release();
    await holding;
    const expected = await manual;
    expect((await outcome).error).toMatchObject({ status: 409 });
    expect(triggers.get(saved.id)).toEqual(expected);
    expect(store.appendMessage).not.toHaveBeenCalled();
  });

  it("refuses replacing redacted app instructions before changing local or remote state", async () => {
    const triggers = manager();
    const prompt = "Review the queue.\n".repeat(180) + "Use token=fixture-secret-value.";
    const saved = await triggers.create({ botId: "bot-1", name: "Private instructions", prompt, app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE" });
    const store = { messagesFor: () => [], appendMessage: vi.fn(() => ({ id: "message-1" })), patchMessage: vi.fn() };
    const service = new AppTriggerRequestService({ triggers, store, botName: () => "Fixture" });
    const submit = (changes: unknown) => service.submit({ botId: "bot-1", threadId: "thread-a", operation: { action: "update", triggerId: saved.id, changes } });
    const before = structuredClone(triggers.list());
    const remote = structuredClone([...broker.harness.composio.instances.entries()]);
    await expect(submit({ name: "Must not apply", instructions: "Only the visible text.", filter: { from: "changed.example" } }))
      .rejects.toMatchObject({ status: 409 });
    expect(triggers.list()).toEqual(before);
    expect([...broker.harness.composio.instances.entries()]).toEqual(remote);
    expect(store.appendMessage).not.toHaveBeenCalled();
    await submit({ name: "Safe rename" });
    expect(triggers.get(saved.id)).toMatchObject({ name: "Safe rename", prompt });
    const edited = prompt + " Changed by the person.";
    await triggers.update(saved.id, { prompt: edited });
    expect(triggers.get(saved.id)?.prompt).toBe(edited);
  });

  it("creates the service copy with a Gmail filter folded into Gmail's own search", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    expect(trigger).toMatchObject({ remote: { state: "active" }, accountId: gmail, accountLabel: "sales", delivery: "poll", eventName: "New Gmail message" });
    const instance = broker.harness.composio.instances.get(trigger.remote.triggerId!);
    expect(instance?.trigger_config).toEqual({ query: "from:acme.com subject:(order)" });
  });

  it("acks an event only after its run is saved: a failure before the save brings the same event back once", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    expect((await broker.deliver(trigger.remote.triggerId!, { subject: "Order #1042", sender: "j@acme.com" }, "msg_1")).status).toBe(200);
    failNextEnqueue = "before-save";
    await expect(triggers.pollOnce(undefined, 0)).rejects.toThrow("disk full");
    expect(runsOf(trigger.id)).toHaveLength(0);
    await triggers.pollOnce(undefined, 0);
    expect(runsOf(trigger.id)).toHaveLength(1);
    expect(runsOf(trigger.id)[0]).toMatchObject({ triggerSource: "webhook", eventSource: "app", deliveryId: "msg_1" });
    expect(broker.harness.d1.rows("SELECT * FROM events WHERE acked_at IS NULL")).toHaveLength(1);
    await triggers.pollOnce(undefined, 0);
    expect(broker.harness.d1.rows("SELECT * FROM events WHERE acked_at IS NULL")).toHaveLength(0);
  });

  it("dedupes a redelivered event: a crash after the run was saved starts no second run", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    await broker.deliver(trigger.remote.triggerId!, { subject: "Order #7" }, "msg_dup");
    failNextEnqueue = "after-save";
    await expect(triggers.pollOnce(undefined, 0)).rejects.toThrow("crashed");
    await triggers.pollOnce(undefined, 0);
    expect(runsOf(trigger.id)).toHaveLength(1);
    expect(eventCount(runsOf(trigger.id)[0]!.prompt)).toBe(1);
    expect(triggers.attempts().map((attempt) => attempt.outcome)).toEqual(["duplicate"]);
    expect(triggers.get(trigger.id)?.received).toBe(0);
  });

  it("turns a burst into at most three runs of up to twenty events, and skips past that", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    for (let index = 0; index < 50; index += 1) await broker.deliver(trigger.remote.triggerId!, { subject: `Order #${index}`, sender: "j@acme.com" });
    await drain(triggers);
    const runs = runsOf(trigger.id);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => eventCount(run.prompt)).sort((a, b) => a - b)).toEqual([10, 20, 20]);
    for (let index = 0; index < 30; index += 1) await broker.deliver(trigger.remote.triggerId!, { subject: `Late #${index}` });
    await drain(triggers);
    expect(runsOf(trigger.id)).toHaveLength(3);
    expect(runsOf(trigger.id).reduce((sum, run) => sum + eventCount(run.prompt), 0)).toBe(60);
    const after = triggers.get(trigger.id)!;
    expect(after.received).toBe(60);
    expect(after.skipped?.tooMany).toBe(20);
    expect(triggers.attempts().filter((attempt) => attempt.outcome === "skipped")).toHaveLength(20);
  });

  it("applies a plain filter to apps that cannot filter at the source", async () => {
    const slack = broker.account(owner.userId, "slack");
    connected.slack = { connected: true, accounts: [{ id: slack, status: "ACTIVE" }] };
    const triggers = manager();
    const trigger = await triggers.create({ botId: "bot-1", name: "Urgent", prompt: "Tell me.", app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED", filter: { text: "urgent" } });
    await broker.deliver(trigger.remote.triggerId!, { text: "lunch?", user: "ada" });
    await broker.deliver(trigger.remote.triggerId!, { text: "URGENT: the site is down", user: "bo" });
    await drain(triggers);
    expect(runsOf(trigger.id)).toHaveLength(1);
    expect(runsOf(trigger.id)[0]!.prompt).toContain("the site is down");
    expect(triggers.get(trigger.id)).toMatchObject({ received: 1, filtered: 1 });
  });

  it("reconciles: a lost copy is made again, one nobody wants is removed, and on/off is matched", async () => {
    const triggers = manager();
    const kept = await gmailTrigger(triggers);
    const client = brokerClient(() => ({ url: broker.url, token: owner.token }));
    await client.remove(kept.remote.triggerId!);
    const stray = await client.create({ slug: "GMAIL_NEW_GMAIL_MESSAGE", connectedAccountId: gmail, config: { query: "stray" } });
    await triggers.reconcile();
    const healed = triggers.get(kept.id)!;
    expect(healed.remote).toMatchObject({ state: "active" });
    expect(broker.harness.composio.instances.has(healed.remote.triggerId!)).toBe(true);
    expect(broker.harness.composio.instances.has(stray.triggerId)).toBe(false);
    await client.setEnabled(healed.remote.triggerId!, false);
    await triggers.reconcile();
    expect((await client.inventory()).triggers.find((binding) => binding.triggerId === healed.remote.triggerId)?.enabled).toBe(true);
    await triggers.update(kept.id, { enabled: false });
    expect((await client.inventory()).triggers.find((binding) => binding.triggerId === healed.remote.triggerId)?.enabled).toBe(false);
  });

  it("pauses the automation of a deleted bot, so the app stops sending its events", async () => {
    let gone = false;
    const triggers = manager({ botState: () => (gone ? "missing" : "ready") });
    const trigger = await gmailTrigger(triggers);
    gone = true;
    await triggers.reconcile();
    expect(triggers.get(trigger.id)?.enabled).toBe(false);
    const client = brokerClient(() => ({ url: broker.url, token: owner.token }));
    expect((await client.inventory()).triggers.find((binding) => binding.triggerId === trigger.remote.triggerId)?.enabled).toBe(false);
  });

  it("says an event that needs setup on our side can't be used yet, and an unknown one can't be watched", async () => {
    const triggers = manager();
    const create = (event: string) => triggers.create({ botId: "bot-1", name: "New mail", prompt: "Summarize it.", app: "gmail", event });
    await expect(create("GMAIL_OWN_ENDPOINT")).rejects.toThrow("GMAIL_OWN_ENDPOINT can't be used yet: this event needs webhook setup on our side first. Pick another event this app offers.");
    await expect(create("GMAIL_NOT_A_THING")).rejects.toThrow("GMAIL_NOT_A_THING is not an event Seira can watch.");
    expect(triggers.list()).toEqual([]);
  });

  it("keeps an automation pending while the service is unreachable, and finishes it on its own", async () => {
    let reachable = false;
    const triggers = manager({ broker: brokerClient(() => ({ url: reachable ? broker.url : "http://127.0.0.1:9", token: owner.token })) });
    await expect(gmailTrigger(triggers)).rejects.toThrow(/could not be reached/);
    reachable = true;
    const trigger = await gmailTrigger(triggers);
    reachable = false;
    await triggers.update(trigger.id, { filter: { from: "globex.com" } }).catch(() => {});
    reachable = true;
    await triggers.reconcile();
    expect(triggers.get(trigger.id)?.remote.state).toBe("active");
  });

  it("shows an expired connection as Reconnect, and clears it once the account works again", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    await broker.expire(gmail);
    await drain(triggers);
    expect(triggers.get(trigger.id)?.problem?.kind).toBe("reconnect");
    connected.gmail!.accounts[0]!.status = "ACTIVE";
    await triggers.reconcile();
    expect(triggers.get(trigger.id)?.problem).toBeUndefined();
  });

  it("counts events the service skipped today for the daily limit", async () => {
    const triggers = manager();
    const trigger = await gmailTrigger(triggers);
    await triggers.reconcile();
    broker.setQueuedToday(owner.id, 500);
    await broker.deliver(trigger.remote.triggerId!, { subject: "Over the limit" });
    await broker.deliver(trigger.remote.triggerId!, { subject: "Also over" });
    await triggers.reconcile();
    expect(triggers.get(trigger.id)?.skipped).toMatchObject({ dailyLimit: 2 });
    expect(triggers.service()).toMatchObject({ plan: "desktop", eventsPerDay: 500, eventsToday: 500 });
  });

  it("deletes the service copy with the last automation that uses it, and Undo brings it back", async () => {
    const triggers = manager();
    const first = await gmailTrigger(triggers);
    const twin = await triggers.create({ botId: "bot-2", name: "Twin", prompt: "Log it.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter: { from: "acme.com", subject: "order" } });
    expect(twin.remote.triggerId).toBe(first.remote.triggerId);
    await triggers.remove(first.id);
    expect(broker.harness.composio.instances.has(twin.remote.triggerId!)).toBe(true);
    await triggers.remove(twin.id);
    expect(broker.harness.composio.instances.size).toBe(0);
    const restored = await triggers.restore(twin.id);
    expect(restored?.remote.state).toBe("active");
    expect(broker.harness.composio.instances.size).toBe(1);
  });
});

describe("appEventCatalog", () => {
  it("lists events only for connected apps the bot may use", async () => {
    const slack = broker.account(owner.userId, "slack");
    connected.slack = { connected: true, accounts: [{ id: slack, status: "ACTIVE" }] };
    const client = brokerClient(() => ({ url: broker.url, token: owner.token }));
    const everything = await appEventCatalog({ broker: client, connected, bot: {} });
    expect(everything.apps.map((app) => app.app)).toEqual(["gmail", "slack"]);
    expect(everything.apps[0]!.events.map((event) => event.event)).toEqual(["GMAIL_NEW_GMAIL_MESSAGE", "GMAIL_EMAIL_SENT"]);
    expect(everything.apps[0]!.events[0]).toMatchObject({ delivery: "poll", filterFields: ["sender", "subject"] });
    const gmailOnly = await appEventCatalog({ broker: client, connected, bot: { connectorTools: { gmail: { tools: "*" } } } });
    expect(gmailOnly.apps.map((app) => app.app)).toEqual(["gmail"]);
    const scoped = await appEventCatalog({ broker: client, connected, bot: { connectorScopes: { apps: { slack: "read" } } } });
    expect(scoped.apps.map((app) => app.app)).toEqual(["slack"]);
    expect((await appEventCatalog({ broker: client, connected, bot: { composio: false } })).apps).toEqual([]);
    expect(everything.notConnected.map((app) => app.app)).not.toContain("gmail");
  });
});

describe("createAppTriggerHost", () => {
  it("refuses a guest-driven Cloud turn and an app outside the bot's grants; otherwise applies with one receipt and Undo", async () => {
    const { createAppTriggerHost } = await import("./app-trigger-host.ts");
    const messages = new Map<string, Array<{ id: string; card?: any }>>();
    const bots: Record<string, any> = {
      scout: { id: "scout", name: "Scout", color: "#000" },
      narrow: { id: "narrow", name: "Narrow", color: "#000", connectorTools: { slack: { tools: "*" } } },
    };
    const host = createAppTriggerHost({
      file: join(dir, "host-app-triggers.json"),
      store: {
        bot: (id) => bots[id],
        messagesFor: (threadId) => messages.get(threadId) ?? [],
        appendMessage: (threadId, message) => {
          const line = { id: `m${(messages.get(threadId)?.length ?? 0) + 1}`, ...message };
          messages.set(threadId, [...(messages.get(threadId) ?? []), line]);
          return line;
        },
        patchMessage: (threadId, messageId, patch) => {
          const line = messages.get(threadId)?.find((candidate) => candidate.id === messageId);
          if (line) Object.assign(line, patch);
          return line;
        },
      },
      connectionMode: () => "managed",
      access: () => ({ url: broker.url, token: owner.token }),
      connectedApps: async () => connected,
      routines: () => routines,
      webhooks: { list: () => [] } as never,
      webhookBase: () => "http://127.0.0.1:8800",
      botState: () => "ready",
      timeZone: () => "UTC",
      visibleBot: () => true,
      emit: () => {},
      audit: () => {},
    });
    const answers: Array<{ status: number; body: any }> = [];
    const json = ((_res: unknown, status: number, body: unknown) => { answers.push({ status, body }); }) as never;
    const operation = { action: "create", trigger: { name: "Acme", instructions: "Draft a reply.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter: { from: "acme.com" } } };
    const context = (from: any, guestDriven = false) => ({ from, threadId: "thread-1", ownsThread: () => true, guestDriven, outsideDriven: () => false, canCommit: () => true });
    await host.submit({} as never, json, { ...context(bots.scout, true), operation });
    expect(answers.at(-1)).toMatchObject({ status: 403, body: { error: expect.stringContaining("Only the Cloud's owner") } });
    await host.submit({} as never, json, { ...context(bots.narrow), operation });
    expect(answers.at(-1)).toMatchObject({ status: 403, body: { error: expect.stringContaining("Narrow has not been given access to Gmail") } });
    expect(host.manager.list()).toEqual([]);
    await host.submit({} as never, json, { ...context(bots.scout), operation });
    expect(answers.at(-1)).toMatchObject({ status: 201, body: { state: "applied", action: "create" } });
    const card = messages.get("thread-1")!.at(-1)!.card;
    expect(card).toMatchObject({ autoApplied: true, answered: "allow", tool: "create_trigger", appTriggerRequest: { operation: { action: "create" } } });
    expect(card.subtitle).toBe("When an email arrives in Gmail (sales) from acme.com (it checks every 15 minutes), Scout follows: Draft a reply.");
    const id = card.appTriggerRequest.resultId as string;
    await host.submit({} as never, json, { ...context(bots.scout), operation: { action: "update", triggerId: id, changes: { filter: { from: "globex.com" } } } });
    const updateCard = messages.get("thread-1")!.at(-1)!.card;
    expect(host.manager.get(id)?.config).toEqual({ query: "from:globex.com" });
    // An event arriving later does not count as a change, so Undo still applies.
    await broker.deliver(host.manager.get(id)!.remote.triggerId!, { subject: "Hello" });
    while (await host.manager.pollOnce(undefined, 0) > 0) { /* drain */ }
    expect(await host.undo({ botId: "scout", threadId: "thread-1", requestId: updateCard.requestId })).toMatchObject({ state: "undone", action: "update" });
    expect(host.manager.get(id)).toMatchObject({ filter: { from: "acme.com" }, config: { query: "from:acme.com" } });
    expect(await host.undo({ botId: "scout", threadId: "thread-1", requestId: card.requestId })).toMatchObject({ state: "undone", action: "create" });
    expect(host.manager.list()).toEqual([]);
    expect(broker.harness.composio.instances.size).toBe(0);
  });
});

describe("instructions in the person's words", () => {
  it("tells the bot to write plain actions, and tells each run where its event is", async () => {
    const { TRIGGER_PROMPT } = await import("./system-prompt.ts");
    const { availableTools, catalogProfileFromEnv } = await import("./drivers/agents-catalog.ts");
    const { eventPrompt } = await import("./app-events.ts");
    expect(TRIGGER_PROMPT).toContain('in the person\'s plain words ("draft a reply"): never "event data", "payload", "webhook" or "trigger"; they read them, and each run is told where its event is');
    const create = availableTools(catalogProfileFromEnv({})).find((tool) => tool.name === "trigger")!;
    expect(create.description).toContain("write name and instructions as they would say them");
    expect((create.inputSchema.properties as Record<string, { description?: string }>).instructions!.description)
      .toContain("in the person's plain words (\"draft a reply\"), never \"event data\", \"payload\", \"webhook\" or \"trigger\"");
    expect(eventPrompt("Draft a reply.", "[UNTRUSTED APP EVENT DATA]\n{}\n[/UNTRUSTED APP EVENT DATA]"))
      .toContain("The email, message or record these instructions mean is in the UNTRUSTED APP EVENT DATA below.");
  });
});

describe("automations made before the owner kept the managed service out", () => {
  type Service = ReturnType<AppTriggerManagerOptions["service"]>;

  function spied() {
    let service: Service = { available: true };
    const fetches: string[] = [];
    const triggers = manager({
      service: () => service,
      broker: brokerClient(() => ({ url: broker.url, token: owner.token }), (input, init) => {
        fetches.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
        return fetch(input, init);
      }),
    });
    return { triggers, fetches, setService: (next: Service) => { service = next; fetches.length = 0; } };
  }

  it.each(["self-hosted", "off"] as const)("%s: pausing, deleting, restoring and syncing change this server's copy and call nothing", async (reason) => {
    const { triggers, fetches, setService } = spied();
    const trigger = await gmailTrigger(triggers);
    const copy = trigger.remote.triggerId!;
    setService({ available: false, reason });

    expect(await triggers.update(trigger.id, { enabled: false })).toMatchObject({ enabled: false, remote: { triggerId: copy, state: "active" } });
    expect(await triggers.update(trigger.id, { restoreConfig: { query: "from:other.com" } })).toMatchObject({ config: { query: "from:other.com" }, remote: { state: "pending" } });
    await triggers.reconcile();
    expect(await triggers.remove(trigger.id)).toBe(true);
    expect(triggers.get(trigger.id)).toBeNull();
    const restored = await triggers.restore(trigger.id);
    expect(restored).toMatchObject({ id: trigger.id, remote: { state: "pending" } });
    expect(restored?.remote.triggerId).toBeUndefined();
    await triggers.reconcile();
    expect(fetches).toEqual([]);
    await expect(triggers.create({ botId: "bot-1", name: "New", prompt: "Tell me.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE" })).rejects.toMatchObject({ status: 409 });
    expect(fetches).toEqual([]);
    expect(triggers.snapshot().service).toEqual({ available: false, reason });
  });

  it("when the managed service comes back, the automation is made again and the old copy is removed", async () => {
    const { triggers, fetches, setService } = spied();
    const trigger = await gmailTrigger(triggers);
    const copy = trigger.remote.triggerId!;
    setService({ available: false, reason: "self-hosted" });
    await triggers.update(trigger.id, { restoreConfig: { query: "from:other.com" } });
    setService({ available: true });
    await triggers.reconcile();
    expect(triggers.get(trigger.id)).toMatchObject({ remote: { state: "active" } });
    expect(triggers.get(trigger.id)?.remote.triggerId).not.toBe(copy);
    expect(fetches).toContain(`DELETE /v1/triggers/${encodeURIComponent(copy)}`);
  });

  it("with no key and no switch, a service not reached yet still gets the calls, and a failed delete is retried", async () => {
    const { triggers, fetches, setService } = spied();
    const trigger = await gmailTrigger(triggers);
    const copy = trigger.remote.triggerId!;
    setService({ available: false, reason: "unavailable" });
    await triggers.update(trigger.id, { enabled: false });
    expect(fetches).toEqual([`PATCH /v1/triggers/${encodeURIComponent(copy)}`]);
    fetches.length = 0;
    await triggers.remove(trigger.id);
    expect(fetches).toEqual([`DELETE /v1/triggers/${encodeURIComponent(copy)}`]);
    fetches.length = 0;
    const restored = await triggers.restore(trigger.id);
    expect(fetches).toContain("POST /v1/triggers");
    expect(restored?.remote.state).toBe("active");
  });

  it("the host reports the switch as off, for the app and for a bot's event list, and calls nothing", async () => {
    vi.stubEnv("SEIRA_COMPOSIO_BROKER", "off");
    try {
      const { createAppTriggerHost } = await import("./app-trigger-host.ts");
      const fetches = vi.fn();
      const host = createAppTriggerHost({
        file: join(dir, "off-app-triggers.json"),
        store: { bot: () => undefined } as never,
        connectionMode: () => "unavailable", access: () => ({ url: broker.url, token: owner.token }),
        connectedApps: async () => connected, routines: () => routines, webhooks: { list: () => [] } as never,
        webhookBase: () => "http://127.0.0.1:8800", botState: () => "ready", timeZone: () => "UTC", visibleBot: () => true,
        emit: () => {}, audit: () => {}, broker: brokerClient(() => null, fetches as unknown as typeof fetch),
      });
      expect(host.manager.service()).toEqual({ available: false, reason: "off" });
      await host.manager.reconcile();
      expect(fetches).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("app-event automation that keeps one conversation", () => {
  it("saves the option, hands it to each run, and turns it off again", async () => {
    const triggers = manager();
    const trigger = await triggers.create({ botId: "bot-1", name: "Order replies", prompt: "Draft a reply.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", sameConversation: true });
    expect(trigger.sameConversation).toBe(true);
    await broker.deliver(trigger.remote.triggerId!, { subject: "Order #1" }, "msg_same_1");
    await drain(triggers);
    expect(runsOf(trigger.id)[0]).toMatchObject({ eventSource: "app", sameConversation: true });
    expect(manager().get(trigger.id)?.sameConversation).toBe(true);

    expect(await triggers.update(trigger.id, { sameConversation: false })).not.toHaveProperty("sameConversation");
    routines.cancelQueuedWebhook(trigger.id, "test");
    await broker.deliver(trigger.remote.triggerId!, { subject: "Order #2" }, "msg_same_2");
    await drain(triggers);
    expect(runsOf(trigger.id)[0]).toMatchObject({ deliveryId: "msg_same_2", status: "queued" });
    expect(runsOf(trigger.id)[0]).not.toHaveProperty("sameConversation");
  });
});

describe("an automation moved off a gone cloud computer", () => {
  it("refuses Test until a place is chosen, and a plain paused one still tests", async () => {
    const trigger = await gmailTrigger(manager());
    const file = join(dir, "app-triggers.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(saved.triggers[0], { enabled: false, runOn: "seira", placeLost: true });
    writeFileSync(file, JSON.stringify(saved));
    const reloaded = manager();
    expect(placeLost(reloaded.list()[0])).toBe(true);
    await expect(reloaded.runNow(trigger.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Choose where it runs/) });
    expect(runsOf(trigger.id)).toEqual([]);
    expect(placeLost(await reloaded.update(trigger.id, { name: "Renamed" }))).toBe(true);
    expect(placeLost(await reloaded.update(trigger.id, { runOn: "seira" }))).toBe(true);
    await expect(reloaded.update(trigger.id, { enabled: true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Choose where it runs/) });
    expect(reloaded.list()[0]).toMatchObject({ enabled: false });
    expect(placeLost(await reloaded.update(trigger.id, { confirmPlace: true }))).toBeUndefined();
    await expect(reloaded.runNow(trigger.id)).resolves.toMatchObject({ via: expect.any(String) });
    // Paused the ordinary way, it is not marked and still tests.
    const plain = await gmailTrigger(reloaded, { from: "other.com", subject: "invoice" });
    await reloaded.update(plain.id, { enabled: false });
    expect(placeLost(reloaded.list().find((row) => row.id === plain.id))).toBeUndefined();
    await expect(reloaded.runNow(plain.id)).resolves.toMatchObject({ via: expect.any(String) });
  });
});

describe("an app-triggers file an earlier version saved", () => {
  it("loads an automation whose run-on value is the old one", async () => {
    const trigger = await gmailTrigger(manager());
    const file = join(dir, "app-triggers.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(/"runOn": ?"seira"/g, '"runOn": "maus"'));
    expect(readFileSync(file, "utf8")).toContain('"maus"');
    const reloaded = manager();
    expect(reloaded.list()).toMatchObject([{ id: trigger.id, runOn: "seira" }]);
  });
});

describe("app event that runs a workflow", () => {
  const copy = { workflowId: "wf-1", prompt: "This routine runs the workflow \"Flow\". Do these steps in order:\n1. Ana: Read the mail", botId: "ana", botIds: ["ana", "ben"] };
  const link = { botId: "ignored", name: "Mail", prompt: "", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", workflowId: "wf-1" };

  it("copies steps to webhook and app trigger prompt", async () => {
    let current = copy;
    const triggers = manager({ workflowCopy: () => current });
    const trigger = await triggers.create(link);
    expect(trigger).toMatchObject({ workflowId: "wf-1", botId: "ana", prompt: copy.prompt });
    const hooks = new WebhookManager({ file: join(dir, "webhooks.json"), botState: () => "ready", enqueue: () => ({ id: "run" }), workflowCopy: () => current });
    const hook = hooks.create({ name: "Orders", workflowId: "wf-1" }).webhook;
    expect(hook).toMatchObject({ workflowId: "wf-1", botId: "ana", prompt: copy.prompt });

    current = { ...copy, prompt: "Do these steps in order:\n1. Ben: Write", botId: "ben" };
    expect(await triggers.update(trigger.id, { rewriteWorkflow: true })).toMatchObject({ prompt: current.prompt, botId: "ben", workflowId: "wf-1" });
    expect(hooks.update(hook.id, { rewriteWorkflow: true })).toMatchObject({ prompt: current.prompt, botId: "ben" });
    expect(await triggers.update(trigger.id, { workflowId: null, enabled: false })).not.toHaveProperty("workflowId");
  });

  it("refuses to link an app trigger to a workflow whose first bot cannot watch the app", async () => {
    const triggers = manager({ workflowCopy: () => copy, botAccessRefusal: (botId, app) => (botId === "ana" ? `Ana can't watch ${app}.` : null) });
    await expect(triggers.create(link)).rejects.toMatchObject({ status: 403, message: "Ana can't watch gmail." });
    expect(triggers.list()).toHaveLength(0);
    const plain = await triggers.create({ ...link, botId: "ben", prompt: "Read it", workflowId: undefined });
    await expect(triggers.update(plain.id, { workflowId: "wf-1" })).rejects.toMatchObject({ status: 403 });
    expect(triggers.get(plain.id)).not.toHaveProperty("workflowId");
  });

  it("switches an app trigger off when the new first bot cannot watch the app", async () => {
    let current = copy;
    const blocked = new Set<string>();
    const triggers = manager({ workflowCopy: () => current, botAccessRefusal: (botId) => (blocked.has(botId) ? "Ben can't watch Gmail." : null) });
    const trigger = await triggers.create(link);
    expect(trigger.enabled).toBe(true);
    blocked.add("ben");
    current = { ...copy, prompt: "Do these steps in order:\n1. Ben: Write", botId: "ben" };
    expect(await triggers.update(trigger.id, { rewriteWorkflow: true })).toMatchObject({ botId: "ben", workflowId: "wf-1", enabled: false });
    await expect(triggers.update(trigger.id, { enabled: true })).rejects.toMatchObject({ status: 403 });
    blocked.clear();
    expect(await triggers.update(trigger.id, { enabled: true })).toMatchObject({ enabled: true, workflowId: "wf-1" });
  });

  it("an app event does not reach a first bot without access after restore", async () => {
    let current = copy;
    const blocked = new Set<string>();
    const triggers = manager({ workflowCopy: () => current, botAccessRefusal: (botId) => (blocked.has(botId) ? "Ben can't watch Gmail." : null) });
    const trigger = await triggers.create(link);
    expect(await triggers.remove(trigger.id)).toBe(true);
    blocked.add("ben");
    current = { ...copy, botId: "ben", prompt: "Do these steps in order:\n1. Ben: Write" };
    const restored = (await triggers.restore(trigger.id))!;
    expect(restored).toMatchObject({ botId: "ben", workflowId: "wf-1", enabled: false });
    await expect(triggers.update(trigger.id, { enabled: true })).rejects.toMatchObject({ status: 403 });
  });

  it("switches an app trigger off and starts no run when an event arrives for a bot without access", async () => {
    let current = copy;
    const blocked = new Set<string>();
    const enqueued: unknown[] = [];
    const triggers = manager({ workflowCopy: () => current, botAccessRefusal: (botId) => (blocked.has(botId) ? "Ben can't watch Gmail." : null), runs: {
      enqueue: (input) => { enqueued.push(input); return { id: "run" }; }, merge: () => null, receipt: () => null, pending: () => 0, cancelQueued: () => {},
    } });
    const trigger = await triggers.create(link);
    blocked.add("ben");
    current = { ...copy, botId: "ben" };
    await broker.deliver(trigger.remote.triggerId!, { subject: "Order #1", sender: "a@acme.com" }, "msg_a");
    await drain(triggers);
    expect(enqueued).toHaveLength(0);
    expect(triggers.get(trigger.id)).toMatchObject({ enabled: false, workflowId: "wf-1" });
  });

  it("unlinking an app trigger switches it off", async () => {
    const triggers = manager({ workflowCopy: () => copy });
    const trigger = await triggers.create(link);
    const patched = (await triggers.update(trigger.id, { workflowId: null }))!;
    expect(patched).not.toHaveProperty("workflowId");
    expect(patched.enabled).toBe(false);
  });

  it("starts a workflow run from an event, and joins a burst into one run", async () => {
    const own = new RoutineManager({ file: join(dir, "routines-wf.json"), botState: () => "busy", createTask: () => ({ threadId: "thread-run" }), startTurn: async () => {}, workflowCopy: () => copy });
    try {
      const triggers = manager({ workflowCopy: () => copy, runs: {
        enqueue: (input) => own.enqueueWebhook(input),
        merge: (triggerId, eventId, same, merge) => own.mergeIntoQueuedRun(triggerId, eventId, same, merge),
        receipt: (triggerId, eventId) => own.webhookRunReceipt(triggerId, eventId),
        pending: (triggerId) => own.activeWebhookRunCount(triggerId),
        cancelQueued: (triggerId, message) => own.cancelQueuedWebhook(triggerId, message),
      } });
      const trigger = await triggers.create(link);
      await broker.deliver(trigger.remote.triggerId!, { subject: "Order #1", sender: "a@acme.com" }, "msg_a");
      await broker.deliver(trigger.remote.triggerId!, { subject: "Order #2", sender: "b@acme.com" }, "msg_b");
      await drain(triggers);
      const runs = own.listRuns().filter((run) => run.routineId === trigger.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ workflowId: "wf-1", workflowBotIds: ["ana", "ben"], botId: "ana", triggerSource: "webhook", eventSource: "app", webhookId: trigger.id });
      expect(eventCount(runs[0]!.prompt)).toBe(2);
      expect(runs[0]!.prompt).toContain("Order #2");
      expect(runs[0]!.prompt).not.toContain("Do these steps");
      expect(runs[0]!.prompt).not.toContain("USER-CONFIGURED");
    } finally {
      own.close();
    }
  });
});

describe("by-id requests to an app trigger", () => {
  async function hostWith(visible: (botId: string) => boolean, gate: (auth: unknown, body: unknown, current: string | undefined) => { status: number; error: string } | null) {
    const { createAppTriggerHost } = await import("./app-trigger-host.ts");
    const bots: Record<string, any> = { scout: { id: "scout", name: "Scout", color: "#000" } };
    const host = createAppTriggerHost({
      file: join(dir, "gate-app-triggers.json"),
      store: { bot: (id) => bots[id], messagesFor: () => [], appendMessage: (_thread, message) => ({ id: "m1", ...message }), patchMessage: () => undefined },
      connectionMode: () => "managed",
      access: () => ({ url: broker.url, token: owner.token }),
      connectedApps: async () => connected,
      routines: () => routines,
      webhooks: { list: () => [] } as never,
      webhookBase: () => "http://127.0.0.1:8800",
      botState: () => "ready",
      timeZone: () => "UTC",
      visibleBot: (_auth, botId) => visible(botId),
      workflowGate: gate as never,
      workflowCopy: () => ({ workflowId: "wf-1", prompt: "Do these steps in order:\n1. Scout: Read it", botId: "scout", botIds: ["scout"] }),
      emit: () => {},
      audit: () => {},
    });
    const call = async (method: string, path: string, body: unknown = {}) => {
      const answers: Array<{ status: number; body: any }> = [];
      const json = ((_res: unknown, status: number, answer: unknown) => { answers.push({ status, body: answer }); }) as never;
      await host.routes({ req: {}, res: {}, url: new URL(`http://localhost${path}`), path, method, auth: { kind: "loopback", scopes: ["admin"] }, json, readBody: async () => body } as never);
      return answers.at(-1)!;
    };
    return { host, call };
  }

  it("answers as for a missing automation, and changes nothing, when the bot is hidden from the person", async () => {
    let seen = true;
    const { host, call } = await hostWith((botId) => seen || botId !== "scout", () => null);
    const trigger = await host.manager.create({ botId: "scout", name: "Mail", prompt: "Read it", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE" });
    seen = false;
    const run = vi.spyOn(host.manager, "runNow");
    const update = vi.spyOn(host.manager, "update");
    const remove = vi.spyOn(host.manager, "remove");
    for (const [method, suffix, body] of [["POST", "/test", {}], ["PATCH", "", { enabled: false }], ["DELETE", "", {}]] as const) {
      expect(await call(method, `/api/app-triggers/${trigger.id}${suffix}`, body)).toEqual({ status: 404, body: { error: "no such automation" } });
    }
    expect([run, update, remove].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    expect(host.manager.get(trigger.id)).toMatchObject({ enabled: true });
  });

  it("holds back a test run when the person may not change the workflow it runs", async () => {
    const { host, call } = await hostWith(() => true, (_auth, _body, current) => (current === "wf-1" ? { status: 403, error: "Ask the owner of Scout." } : null));
    const trigger = await host.manager.create({ botId: "scout", name: "Mail", prompt: "", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", workflowId: "wf-1" });
    const run = vi.spyOn(host.manager, "runNow");
    expect(await call("POST", `/api/app-triggers/${trigger.id}/test`)).toEqual({ status: 403, body: { error: "Ask the owner of Scout." } });
    expect(run).not.toHaveBeenCalled();
  });
});
