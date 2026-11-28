import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlSeira } from "../scripts/control-seira.ts";

it("a workflow that keeps one conversation goes on in a chat only while its model, approval and access still fit", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  try {
    const planPath = join(fixture.info.dataDir, "room-plan.json");
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${fixture.info.url}${path}`, { method,
        headers: { "content-type": "application/json", origin: fixture.info.url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json() as any;
      expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
      return value;
    };
    const cli = (...args: string[]) => runControlSeira([...args, "--url", fixture.info.url]) as Promise<any>;
    const { bot: scout } = await cli("new-bot", "--name", "Scout");
    const { bot: writer } = await cli("new-bot", "--name", "Writer");
    writeFileSync(planPath, JSON.stringify({ [scout.id]: { reply: "Alpha findings" }, [writer.id]: { reply: "Beta write-up" } }));
    const position = { x: 0, y: 0 };
    const { workflow } = await api("POST", "/api/workflows", {
      name: "Findings",
      steps: [
        { id: "a", kind: "bot", botId: scout.id, instruction: "Collect the findings.", position },
        { id: "b", kind: "bot", botId: writer.id, instruction: "Write them up.", position },
      ],
      connections: [{ id: "c1", from: "a", to: "b" }],
    });
    const { routine } = await api("POST", "/api/routines", {
      name: "Findings run", botId: scout.id, workflowId: workflow.id, prompt: "unused", sameConversation: true,
      schedule: { type: "daily", time: "09:00" }, enabled: false,
    });
    const turns = () => (existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { botId: string; threadId?: string; permissionMode?: string })
      : []);
    const chats = async () => {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.status,
        { timeout: 60_000 }).toBe("completed");
      const { run: workflowRun } = await api("GET", `/api/workflow-runs/${run.id}`);
      const chat = (stepId: string) => workflowRun.stepRuns.find((step: any) => step.stepId === stepId)?.threadId as string;
      return { scout: chat("a"), writer: chat("b") };
    };
    const modeIn = (threadId: string) => turns().findLast((turn) => turn.threadId === threadId)?.permissionMode;

    const first = await chats();
    expect(first.scout).toBeTruthy();
    expect(first.writer).toBeTruthy();
    expect(await chats()).toEqual(first);

    const otherModel = scout.modelSelection?.model === "claude-opus-5" ? "claude-sonnet-5" : "claude-opus-5";
    await api("PATCH", `/api/bots/${scout.id}/tasks/${first.scout}`, { modelSelection: { instanceId: "claude", model: otherModel } });
    const newModel = await chats();
    expect(newModel.scout).not.toBe(first.scout);
    expect(newModel.writer).toBe(first.writer);

    const otherMode = modeIn(first.writer) === "default" ? "full" : "ask";
    await api("PATCH", `/api/bots/${writer.id}/tasks/${first.writer}`, { approvalMode: otherMode });
    const newApproval = await chats();
    expect(newApproval.scout).toBe(newModel.scout);
    expect(newApproval.writer).not.toBe(first.writer);

    await api("PATCH", `/api/routines/${routine.id}`, { access: "read-and-draft" });
    const fenced = await chats();
    expect(fenced.scout).not.toBe(newApproval.scout);
    expect(fenced.writer).not.toBe(newApproval.writer);
    expect([modeIn(fenced.scout), modeIn(fenced.writer)]).toEqual(["default", "default"]);
    expect(modeIn(newApproval.scout)).not.toBe("default");
    expect(await chats()).toEqual(fenced);
  } finally { await fixture.close(); }
}, 240_000);
