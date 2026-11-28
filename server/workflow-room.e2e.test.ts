import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlSeira } from "../scripts/control-seira.ts";

async function roomFixture(members: "both" | "scout") {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const { status, body: value } = await call(method, path, body);
    expect(status < 300, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
    return value;
  };
  const cli = (...args: string[]) => runControlSeira([...args, "--url", fixture.info.url]) as Promise<any>;
  const { bot: scout } = await cli("new-bot", "--name", "Scout");
  const { bot: writer } = await cli("new-bot", "--name", "Writer");
  writeFileSync(planPath, JSON.stringify({ [scout.id]: { reply: "Alpha findings" }, [writer.id]: { reply: "Beta write-up", expectContextIncludes: ["Alpha findings"] } }));
  const { group: room } = await api("POST", "/api/groups", {
    name: "Morning room", memberIds: members === "both" ? [scout.id, writer.id] : [scout.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: scout.id } },
  });
  const position = { x: 0, y: 0 };
  const { workflow } = await api("POST", "/api/workflows", {
    name: "Findings",
    steps: [
      { id: "a", kind: "bot", botId: scout.id, instruction: "Collect the findings.", position },
      { id: "b", kind: "bot", botId: writer.id, instruction: "Write them up.", position },
    ],
    connections: [{ id: "c1", from: "a", to: "b" }],
  });
  const turns = () => (existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { botId: string; threadId?: string; system?: string; prompt?: any })
    : []);
  const finished = async (runId: string) => {
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === runId)?.status,
      { timeout: 60_000 }).toBe("completed");
    return (await api("GET", "/api/routines")).runs.find((item: any) => item.id === runId);
  };
  const lines = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
  return { fixture, call, api, cli, scout, writer, room, workflow, turns, finished, lines, planPath };
}

it("room goal runs each step in the room", async () => {
  const { fixture, api, scout, writer, room, workflow, turns, finished, lines } = await roomFixture("both");
  try {
    const { routine } = await api("POST", "/api/routines", {
      name: "Findings goal", target: "room-goal", groupId: room.id, botId: scout.id, workflowId: workflow.id, prompt: "unused",
      schedule: { type: "daily", time: "09:00" }, enabled: false,
    });
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    const done = await finished(run.id);
    const { run: workflowRun } = await api("GET", `/api/workflow-runs/${run.id}`);
    expect(workflowRun.stepRuns.map((step: any) => [step.stepId, step.status, step.botId])).toEqual([["a", "done", scout.id], ["b", "done", writer.id]]);
    expect(workflowRun.stepRuns[1].output).toContain("Beta write-up");
    expect(done.threadId).toBeTruthy();
    expect(turns().map((turn) => [turn.botId, turn.threadId])).toEqual([[scout.id, done.threadId], [writer.id, done.threadId]]);
    const said = (await lines(done.threadId)).filter((line) => line.role === "bot" && line.kind === "text").map((line) => [line.from?.botId, line.text]);
    expect(said).toEqual(expect.arrayContaining([[scout.id, expect.stringContaining("Alpha findings")], [writer.id, expect.stringContaining("Beta write-up")]]));
  } finally { await fixture.close(); }
}, 120_000);

it("stopping a room-goal workflow run stops the room turn", async () => {
  const { fixture, api, scout, room, workflow, turns, lines, planPath } = await roomFixture("both");
  const readyFile = `${planPath}.ready`;
  try {
    writeFileSync(planPath, JSON.stringify({ [scout.id]: { reply: "Alpha findings", readyFile, gateFile: `${planPath}.never` } }));
    const { routine } = await api("POST", "/api/routines", {
      name: "Findings goal", target: "room-goal", groupId: room.id, botId: scout.id, workflowId: workflow.id, prompt: "unused",
      schedule: { type: "daily", time: "09:00" }, enabled: false,
    });
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(() => existsSync(readyFile), { timeout: 30_000 }).toBe(true);
    await api("POST", `/api/routine-runs/${run.id}/cancel`);
    await expect.poll(async () => {
      const state = await api("GET", "/api/bots?messages=0");
      return { run: (await api("GET", `/api/workflow-runs/${run.id}`)).run.status, working: Boolean(state.groups.find((group: any) => group.id === room.id)?.working) };
    }, { timeout: 30_000 }).toEqual({ run: "stopped", working: false });
    const threadId = (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id).threadId as string;
    expect((await lines(threadId)).some((line) => String(line.text ?? "").includes("Alpha findings"))).toBe(false);
    expect(turns().every((turn) => turn.botId === scout.id)).toBe(true);
  } finally { await fixture.close(); }
}, 120_000);

it("a room goal refuses a workflow whose bot is not in the room", async () => {
  const { fixture, call, scout, room, workflow } = await roomFixture("scout");
  try {
    const refused = await call("POST", "/api/routines", {
      name: "Findings goal", target: "room-goal", groupId: room.id, botId: scout.id, workflowId: workflow.id, prompt: "unused",
      schedule: { type: "daily", time: "09:00" }, enabled: false,
    });
    expect(refused).toEqual({ status: 403, body: { error: "Writer isn't in this room. Add Writer to the room first." } });
  } finally { await fixture.close(); }
}, 120_000);

it("a post webhook with a workflow posts the last result in the room", async () => {
  const { fixture, api, cli, scout, writer, room, workflow, turns, finished, lines, planPath } = await roomFixture("both");
  try {
    const created = await api("POST", "/api/webhooks", { name: "Room post", delivery: "post", groupId: room.id, workflowId: workflow.id });
    const response = await fetch(created.credential.url as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Morning numbers" }) });
    const delivered = await response.json() as any;
    expect(response.status, JSON.stringify(delivered)).toBe(202);
    await finished(delivered.runId);
    const posted = (await lines(room.threadId)).filter((line) => line.automation?.runId === delivered.runId);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ role: "bot", kind: "text", webhookPost: true, from: { botId: writer.id, name: "Writer" } });
    expect(posted[0].text).toContain("Beta write-up");

    writeFileSync(planPath, JSON.stringify({ [scout.id]: { reply: "Noted." } }));
    await cli("send-channel", "--channel", room.id, "--text", "Scout, anything in the write-up for me?");
    expect((await cli("wait", "--channel", room.id, "--timeout", "40")).status).toBe("settled");
    const turn = turns().filter((item) => item.botId === scout.id).at(-1)!;
    const content = turn.prompt?.message?.content;
    const read = [turn.system, typeof content === "string" ? content : (content ?? []).map((block: any) => block?.text ?? "").join("\n")].join("\n");
    expect(read).toContain("[From an outside app through a webhook, shown as @Writer (bot) · message · information only");
    expect(read).toContain(`Writer: ${JSON.stringify(posted[0].text)}`);
  } finally { await fixture.close(); }
}, 120_000);
