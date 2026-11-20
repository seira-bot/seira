import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlSeira } from "../scripts/control-seira.ts";

const SECRET = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;

async function runWorkflow(reply: string) {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const cli = (...args: string[]) => runControlSeira([...args, "--url", fixture.info.url]) as Promise<any>;
  const { bot: first } = await cli("new-bot", "--name", "Scout");
  const { bot: second } = await cli("new-bot", "--name", "Writer");
  writeFileSync(planPath, JSON.stringify({ [first.id]: { reply: "Alpha findings" }, [second.id]: { reply } }));
  const position = { x: 0, y: 0 };
  const { workflow } = await api("POST", "/api/workflows", {
    name: "Findings to post",
    steps: [
      { id: "a", kind: "bot", botId: first.id, instruction: "Collect the findings.", position },
      { id: "b", kind: "bot", botId: second.id, instruction: "Write them up.", position },
      { id: "p", kind: "post", position },
    ],
    connections: [{ id: "c1", from: "a", to: "b" }, { id: "c2", from: "b", to: "p" }],
  });
  const { routine } = await api("POST", "/api/routines", {
    name: "Findings run", botId: first.id, workflowId: workflow.id, prompt: "unused",
    schedule: { type: "daily", time: "09:00" }, enabled: false,
  });
  const { run } = await api("POST", `/api/routines/${routine.id}/run`);
  await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.status,
    { timeout: 60_000 }).toBe("completed");
  const { run: workflowRun } = await api("GET", `/api/workflow-runs/${run.id}`);
  return { fixture, api, first, second, routine, run, workflowRun };
}

it("a routine that runs a workflow runs its steps on Run now, with no finished notice per step", async () => {
  const { fixture, api, first, workflowRun, run } = await runWorkflow("Beta write-up");
  try {
    expect(workflowRun.status).toBe("completed");
    expect(workflowRun.stepRuns.map((step: any) => [step.stepId, step.status])).toEqual([["a", "done"], ["b", "done"], ["p", "done"]]);
    expect(workflowRun.stepRuns[0].output).toContain("Alpha findings");
    expect(workflowRun.stepRuns[1].output).toContain("Beta write-up");
    const threads = [...new Set([first.activeTaskId, ...Object.values(workflowRun.threads)])] as string[];
    const lines = (await Promise.all(threads.map(async (threadId) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[])))
      .flat().filter((message) => message.automation?.runId === run.id && message.automation?.workflowStepId === "p");
    expect(lines).toHaveLength(1);
    const notices = (await api("GET", "/api/notifications")).notifications as Array<{ kind: string; threadId?: string }>;
    const stepThreads = new Set(Object.values(workflowRun.threads) as string[]);
    expect(notices.filter((notice) => notice.threadId && stepThreads.has(notice.threadId) && notice.kind === "done")).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("a person's own reply in a step chat right after the run ends still raises its notice", async () => {
  const { fixture, api, second, workflowRun } = await runWorkflow("Beta write-up");
  const cli = (...args: string[]) => runControlSeira([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const threadId = workflowRun.threads[second.id] as string;
    await cli("send", "--bot", second.id, "--task", threadId, "--text", "Thanks, please shorten it.");
    await expect.poll(async () => {
      const notices = (await api("GET", "/api/notifications")).notifications as Array<{ kind: string; threadId?: string }>;
      return notices.filter((notice) => notice.threadId === threadId && notice.kind === "done").length;
    }, { timeout: 60_000 }).toBeGreaterThan(0);
  } finally { await fixture.close(); }
}, 150_000);

it("hides a secret in a step's output before it is stored", async () => {
  const { fixture, workflowRun } = await runWorkflow(`The key is ${SECRET} for now`);
  try {
    expect(JSON.stringify(workflowRun)).not.toContain(SECRET);
    expect(workflowRun.stepRuns[1].output).toContain("The key is");
  } finally { await fixture.close(); }
}, 120_000);
