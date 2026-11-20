// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DrawnWorkflow, Workflow } from "../../../shared/workflows";
import type { Message } from "@/state/store";
import { resetWorkflowsForTest, useWorkflowsUnavailable } from "@/state/workflows";

const fixture = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

const { ApiError } = await import("@/state/store");
const { drawWorkflow, finishedReply } = await import("./draw-workflow");
const { createWorkflowOnce } = await import("./useCreateWorkflow");

const DRAFT_PATH = "/api/threads/t-1/messages/m-1/workflow-draft";
const botStep = (id: string, y: number) => ({ id, kind: "bot" as const, botId: "bot-a", instruction: "Do it", position: { x: 0, y } });
const drawn = (over: Partial<DrawnWorkflow> = {}, name = "Summarize today's orders"): DrawnWorkflow => ({
  draft: { name, steps: [botStep("s-1", 0), botStep("s-2", 160)], connections: [{ id: "c-1", from: "s-1", to: "s-2" }] },
  omitted: 0, trimmed: 0, ...over,
});
const saved: string[] = [];
let answer: () => Promise<unknown>;
const dispatch = vi.fn();
const notices = () => dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "notice").map((action) => action.notice);

beforeEach(() => {
  resetWorkflowsForTest();
  dispatch.mockReset();
  saved.length = 0;
  answer = async () => drawn();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
    if (path === DRAFT_PATH) return answer();
    if (path === "/api/workflows" && (init as { method?: string } | undefined)?.method === "POST") {
      const body = (init as { body: string }).body;
      saved.push(body);
      return { workflow: { ...JSON.parse(body), id: "wf-new", createdAt: 1, updatedAt: 2 } as Workflow };
    }
    return {};
  });
});
afterEach(() => resetWorkflowsForTest());

const draw = () => drawWorkflow({ threadId: "t-1", messageId: "m-1" }, dispatch);

describe("draw as workflow", () => {
  it("saves the drawn workflow and opens it on the canvas", async () => {
    await draw();
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]!)).toMatchObject({ name: "Summarize today's orders", steps: [{ id: "s-1" }, { id: "s-2" }], connections: [{ id: "c-1" }] });
    expect(dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "workflows", workflowId: "wf-new" });
    expect(notices()).toEqual([]);
  });

  it("names a draft without words Untitled workflow", async () => {
    answer = async () => drawn({}, "");
    await draw();
    expect(JSON.parse(saved[0]!).name).toBe("Untitled workflow");
  });

  it("says how many steps it left out, and when it stopped at the limit", async () => {
    answer = async () => drawn({ omitted: 1 });
    await draw();
    expect(notices().at(-1)).toMatchObject({ kind: "note", text: "Left out 1 step. Its bot isn't available to you." });
    answer = async () => drawn({ omitted: 2, trimmed: 4 });
    await draw();
    expect(notices().at(-1)?.text).toBe("Left out 2 steps. Their bots aren't available to you. Drew the first 50 steps. A workflow can't hold more.");
    answer = async () => drawn({ trimmed: 1 });
    await draw();
    expect(notices().at(-1)?.text).toBe("Drew the first 50 steps. A workflow can't hold more.");
    expect(dispatch.mock.calls.filter(([action]) => action.type === "showRoutines")).toHaveLength(3);
  });

  it("shows a plain sentence for a gone message, a view-only bot, a request without words and any other failure", async () => {
    const fail = async (error: unknown) => { answer = async () => { throw error; }; await draw(); return notices().at(-1)?.text; };
    expect(await fail(new ApiError("no such message", 404))).toBe("Couldn't draw the workflow. This message is no longer in the chat.");
    expect(await fail(new ApiError("no", 403))).toBe("You can only view this bot, so you can't draw its work as a workflow.");
    expect(await fail(new ApiError("x", 409, { code: "workflow_draw_no_request" }))).toBe("Couldn't draw the workflow. The message this answers has no words to start from.");
    const other = "Couldn't draw the workflow. Check that you're online and try again.";
    expect(await fail(new ApiError("x", 409, { code: "workflow_draw_unfinished" }))).toBe(other);
    expect(await fail(new ApiError("x", 503, { error: "asleep" }))).toBe(other);
    expect(await fail(new Error("offline"))).toBe(other);
    expect(saved).toEqual([]);
    expect(dispatch.mock.calls.some(([action]) => action.type === "showRoutines")).toBe(false);
  });

  it("says workflows are unavailable on a 503 and hides the item once the list agrees", async () => {
    vi.useFakeTimers();
    try {
      const base = fixture.api.getMockImplementation()!;
      fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
        if (path === "/api/workflows" && !(init as { method?: string } | undefined)?.method) throw new ApiError("down", 503);
        return base(path, init);
      });
      answer = async () => { throw new ApiError("Workflows are unavailable.", 503); };
      await draw();
      expect(notices().at(-1)?.text).toBe("Couldn't draw the workflow. Workflows aren't available right now.");
      expect(useWorkflowsUnavailable()).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(useWorkflowsUnavailable()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts one drawing at a time, and blocks New workflow meanwhile", async () => {
    let release!: () => void;
    answer = () => new Promise((resolve) => { release = () => resolve(drawn()); });
    const first = draw();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await draw();
    expect(fixture.api.mock.calls.filter(([path]) => path === DRAFT_PATH)).toHaveLength(1);
    expect(await createWorkflowOnce(async () => ({ name: "New", steps: [], connections: [] }))).toBeNull();
    release();
    await first;
    expect(saved).toHaveLength(1);
    expect(await createWorkflowOnce(async () => ({ name: "New", steps: [], connections: [] }))).not.toBeNull();
  });

  it("offers the item only on a finished bot reply", () => {
    const reply: Message = { id: "m-1", role: "bot", kind: "text", at: 1, text: "Done.", turnTerminal: true, from: { botId: "bot-a", name: "Lumi", color: "blue" } };
    expect(finishedReply(reply)).toBe(true);
    expect(finishedReply({ ...reply, from: undefined, requestMessageId: "m-0" })).toBe(true);
    expect(finishedReply({ ...reply, turnTerminal: undefined })).toBe(false);
    expect(finishedReply({ ...reply, turnSucceeded: false })).toBe(false);
    expect(finishedReply({ ...reply, role: "user" })).toBe(false);
    expect(finishedReply({ ...reply, id: "optimistic-1" })).toBe(false);
    expect(finishedReply({ ...reply, text: "  " })).toBe(false);
    expect(finishedReply({ ...reply, kind: "activity" })).toBe(false);
    expect(finishedReply({ ...reply, from: undefined })).toBe(false);
  });
});
