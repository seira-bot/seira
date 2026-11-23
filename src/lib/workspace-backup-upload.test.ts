import { describe, expect, it, vi } from "vitest";
import { CLIENT_CHUNK_BYTES, uploadBackupInChunks } from "./workspace-backup-upload";

const MIB = 1024 ** 2;
const base = "/api/workspace-backup/upload";

/** A fake server that stores parts in order, like the real one, and can fail on demand. */
function fakeServer(options: { failures?: Array<unknown> } = {}) {
  const failures = [...(options.failures ?? [])];
  const state = { id: "upload-1", received: 0, parts: [] as Array<{ offset: number; size: number }>, finished: false, calls: [] as string[] };
  const api = vi.fn(async (path: string, init?: { method?: string; body?: BodyInit }) => {
    const body = init?.body as Blob;
    state.calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === `${base}/start`) return { id: state.id, chunkBytes: 32 * MIB };
    if (path === `${base}/${state.id}`) return { received: state.received };
    if (path === `${base}/${state.id}/finish`) { state.finished = true; return { id: state.id }; }
    const offset = Number(new URL(path, "http://x").searchParams.get("offset"));
    const next = failures.shift();
    if (next === "lost-after-store") { state.received = offset + body.size; throw new TypeError("network"); }
    if (next) throw next;
    expect(offset).toBe(state.received);
    state.parts.push({ offset, size: body.size });
    state.received += body.size;
    return { received: state.received };
  });
  return { api, state };
}
const noWait = () => Promise.resolve();

describe("uploadBackupInChunks", () => {
  it("keeps each part under the limit of the edge and reports progress", async () => {
    expect(CLIENT_CHUNK_BYTES).toBeLessThanOrEqual(32 * MIB);
    const { api, state } = fakeServer();
    const progress: number[] = [];
    const id = await uploadBackupInChunks(new Blob(["abcde"]), { api, chunkBytes: 2, wait: noWait, onProgress: (percent) => progress.push(percent) });
    expect(id).toBe("upload-1");
    expect(state.parts).toEqual([{ offset: 0, size: 2 }, { offset: 2, size: 2 }, { offset: 4, size: 1 }]);
    expect(state.finished).toBe(true);
    expect(state.calls.filter((call) => call.includes("/chunk?"))).toEqual([2, 2, 1].map((size, index) => `POST ${base}/upload-1/chunk?offset=${index * 2}&bytes=${size}`));
    expect(progress).toEqual([0, 40, 80, 100]);
  });

  it("waits, asks the server for its byte count, and resumes after a lost part", async () => {
    const { api, state } = fakeServer({ failures: [new TypeError("network"), "lost-after-store", Object.assign(new Error("gateway"), { status: 502 })] });
    const wait = vi.fn(noWait);
    await uploadBackupInChunks(new Blob(["abcdef"]), { api, chunkBytes: 2, wait, onProgress: () => {} });
    expect(wait).toHaveBeenCalledTimes(3);
    expect(state.received).toBe(6);
    expect(state.calls.filter((call) => call === `GET ${base}/upload-1`).length).toBeGreaterThanOrEqual(3);
    expect(state.parts.map((part) => part.offset)).toEqual([2, 4]);
    expect(state.finished).toBe(true);
  });

  it("stops with a plain message after four failures in a row", async () => {
    const { api } = fakeServer({ failures: Array.from({ length: 10 }, () => new TypeError("network")) });
    await expect(uploadBackupInChunks(new Blob(["abcdef"]), { api, chunkBytes: 2, wait: noWait, onProgress: () => {} })).rejects.toThrow("upload stopped");
  });

  it("does not retry a refusal that a retry cannot fix", async () => {
    const refusal = Object.assign(new Error("Too large"), { status: 413 });
    const { api } = fakeServer({ failures: [refusal] });
    const wait = vi.fn(noWait);
    await expect(uploadBackupInChunks(new Blob(["abcdef"]), { api, chunkBytes: 2, wait, onProgress: () => {} })).rejects.toBe(refusal);
    expect(wait).not.toHaveBeenCalled();
  });

  it("resumes an earlier upload from the byte count of the server", async () => {
    const { api, state } = fakeServer();
    state.received = 4;
    await uploadBackupInChunks(new Blob(["abcdef"]), { api, chunkBytes: 2, wait: noWait, resumeId: "upload-1", onProgress: () => {} });
    expect(state.calls.some((call) => call.endsWith("/start"))).toBe(false);
    expect(state.parts).toEqual([{ offset: 4, size: 2 }]);
  });

  it("starts again when the earlier upload expired", async () => {
    const { api, state } = fakeServer();
    const real = api.getMockImplementation()!;
    api.mockImplementation(async (path, init) => {
      if (path === `${base}/old`) throw Object.assign(new Error("expired"), { status: 404 });
      return real(path, init);
    });
    await uploadBackupInChunks(new Blob(["ab"]), { api, chunkBytes: 2, wait: noWait, resumeId: "old", onProgress: () => {} });
    expect(state.calls).toContain(`POST ${base}/start`);
    expect(state.finished).toBe(true);
  });
});
