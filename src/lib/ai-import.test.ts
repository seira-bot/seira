import { beforeEach, describe, expect, it, vi } from "vitest";

import { AI_IMPORT_EVENT, AI_IMPORT_FILE_NAME_HEADER, AI_IMPORT_PATH } from "../../shared/ai-import/api";
import { job } from "../components/ai-import/test-jobs";

const apiMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@/state/api", () => ({ api: apiMock }));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: listenMock }));

import { aiImportApi, jobFromFrame, pickedFiles, uploadAll } from "./ai-import";

beforeEach(() => { apiMock.mockReset(); listenMock.mockReset(); });

describe("ai import client", () => {
  it("sends a file as a raw body with its name in the header", async () => {
    apiMock.mockResolvedValue({ uploadId: "u1" });
    const blob = new Blob(["x"]);
    await expect(aiImportApi.upload(blob, "folder/part 1.zip")).resolves.toBe("u1");
    const [path, init] = apiMock.mock.calls[0]!;
    expect(path).toBe(`${AI_IMPORT_PATH}/uploads`);
    expect(init).toMatchObject({ method: "POST", body: blob });
    expect(init.headers[AI_IMPORT_FILE_NAME_HEADER]).toBe("folder%2Fpart%201.zip");
    expect(init.headers["content-type"]).toBe("application/octet-stream");
  });

  it("calls every job route", async () => {
    apiMock.mockResolvedValue({ jobs: [], sources: [] });
    await aiImportApi.localSources();
    await aiImportApi.list();
    await aiImportApi.get("a/b");
    await aiImportApi.create({ from: "local", sourceId: "s1" });
    await aiImportApi.apply("j1", { destinations: { a1: { kind: "new" } } });
    await aiImportApi.cancel("j1");
    await aiImportApi.undo("j1");
    const calls = apiMock.mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`);
    expect(calls).toEqual([
      `GET ${AI_IMPORT_PATH}/local`,
      `GET ${AI_IMPORT_PATH}/jobs`,
      `GET ${AI_IMPORT_PATH}/jobs/a%2Fb`,
      `POST ${AI_IMPORT_PATH}/jobs`,
      `POST ${AI_IMPORT_PATH}/jobs/j1/apply`,
      `POST ${AI_IMPORT_PATH}/jobs/j1/cancel`,
      `POST ${AI_IMPORT_PATH}/jobs/j1/undo`,
    ]);
    expect(JSON.parse(apiMock.mock.calls[3]![1].body)).toEqual({ from: "local", sourceId: "s1" });
    expect(JSON.parse(apiMock.mock.calls[4]![1].body)).toEqual({ destinations: { a1: { kind: "new" } } });
  });

  it("passes job changes from the event stream, and ignores other frames", () => {
    let listener: { onFrame: (frame: unknown) => void; onMissedFrames?: () => void } | undefined;
    const stop = vi.fn();
    listenMock.mockImplementation((given) => { listener = given; return stop; });
    const seen: string[] = [];
    const unsubscribe = aiImportApi.subscribe((changed) => seen.push(changed.state));
    listener!.onFrame({ kind: "ping" });
    listener!.onFrame({ kind: AI_IMPORT_EVENT, job: job({ state: "reading" }) });
    listener!.onFrame({ kind: "event", event: { type: AI_IMPORT_EVENT, job: job({ state: "done" }) } });
    expect(seen).toEqual(["reading", "done"]);
    unsubscribe();
    expect(stop).toHaveBeenCalled();
  });

  it("reads a job from either frame shape", () => {
    expect(jobFromFrame({ type: AI_IMPORT_EVENT, job: job() })?.id).toBe("job-1");
    expect(jobFromFrame({ kind: AI_IMPORT_EVENT, job: { nope: true } })).toBeNull();
    expect(jobFromFrame(null)).toBeNull();
  });

  it("uploads files one by one, in order, and reports progress", async () => {
    const order: string[] = [];
    const client = { upload: vi.fn(async (_file: Blob, name: string) => { order.push(name); return `id-${name}`; }) };
    const progress: number[] = [];
    const ids = await uploadAll(client, [{ file: new File([], "a"), name: "a" }, { file: new File([], "b"), name: "b" }], (done) => progress.push(done));
    expect(ids).toEqual(["id-a", "id-b"]);
    expect(order).toEqual(["a", "b"]);
    expect(progress).toEqual([1, 2]);
  });

  it("names picked folder files by their path", () => {
    const file = new File([], "SOUL.md");
    Object.defineProperty(file, "webkitRelativePath", { value: "profile/SOUL.md" });
    expect(pickedFiles([file])[0]!.name).toBe("profile/SOUL.md");
    expect(pickedFiles([new File([], "x.zip")])[0]!.name).toBe("x.zip");
  });
});
