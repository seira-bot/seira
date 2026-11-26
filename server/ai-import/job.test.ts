import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiImportEvent, ImportJobView } from "../../shared/ai-import/api.ts";
import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import type { Store } from "../store.ts";
import { importedThreadStats } from "../store-imported.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { AiImportJobs, ImportJobError, type AiImportJobsOptions } from "./job.ts";
import type { ImportPorts } from "./ports.ts";
import { importHarness } from "./testing/harness.ts";
import type { FakeScript } from "./testing/fake-readers.ts";

const READERS_MODULE = new URL("./testing/fake-readers.ts", import.meta.url).href;
const WAIT_MS = 30_000;

interface Seen {
  at: number;
  job: ImportJobView;
}

let dirs: string[] = [];
let opened: AiImportJobs[] = [];

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(opened.map((jobs) => jobs.close()));
  opened = [];
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

function fixture(extra: Partial<AiImportJobsOptions> = {}, wrap?: (ports: ImportPorts) => ImportPorts) {
  const dir = mkdtempSync(join(tmpdir(), "ai-import-job-"));
  dirs.push(dir);
  const harness = importHarness();
  const ports = wrap ? wrap(harness.ports) : harness.ports;
  const seen: Seen[] = [];
  const listeners = new Set<(job: ImportJobView) => void>();
  const options: AiImportJobsOptions = {
    dir, ports, locate: async () => [], readersModule: READERS_MODULE,
    broadcast: (event: AiImportEvent) => {
      seen.push({ at: Date.now(), job: event.job });
      for (const listener of listeners) listener(event.job);
    },
    ...extra,
  };
  const make = () => {
    const jobs = new AiImportJobs(options);
    opened.push(jobs);
    return jobs;
  };
  return { dir, harness, store: harness.store, seen, listeners, make, options };
}

async function upload(jobs: AiImportJobs, script: FakeScript, name = "fake-export.json"): Promise<string> {
  const saved = await jobs.uploads.save(Readable.from([Buffer.from(JSON.stringify(script))]), name);
  return saved.id;
}

function waitFor(jobs: AiImportJobs, listeners: Set<(job: ImportJobView) => void>, id: string, done: (job: ImportJobView) => boolean): Promise<ImportJobView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`Timed out. Last state: ${jobs.list().find((job) => job.id === id)?.state ?? "none"}`));
    }, WAIT_MS);
    const listener = (job: ImportJobView) => {
      if (job.id !== id || !done(job)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(job);
    };
    listeners.add(listener);
    const current = jobs.list().find((job) => job.id === id);
    if (current) listener(current);
  });
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const importedThreads = (store: Store) => store.bots.flatMap((bot) => (bot.tasks ?? []).filter((task) => task.imported));
const importedMessages = (store: Store) =>
  importedThreads(store).reduce((sum, task) => sum + (importedThreadStats(task.threadId)?.messages ?? 0), 0);

describe("reading", () => {
  it("first counts", async () => {
    const { make, listeners } = fixture();
    const jobs = make();
    jobs.start();
    const id = await upload(jobs, { agents: 1, conversations: 6, messagesPer: 2, delayMs: 200 });
    const counted = new Promise<number>((resolve) => {
      listeners.add((job) => {
        if (Object.values(job.counts).some((count) => count > 0)) resolve(Date.now());
      });
    });
    const started = Date.now();
    await jobs.create({ from: "upload", uploadIds: [id] });
    expect(await counted - started).toBeLessThanOrEqual(3000);
    await jobs.close();
  });

  it("progress rate", async () => {
    const { make, seen, listeners } = fixture();
    const jobs = make();
    jobs.start();
    const id = await upload(jobs, { agents: 1, conversations: 10, messagesPer: 2, delayMs: 300 });
    const job = await jobs.create({ from: "upload", uploadIds: [id] });
    await waitFor(jobs, listeners, job.id, (view) => view.state === "ready");
    const times = seen.filter((entry) => entry.job.id === job.id && entry.job.state === "reading").map((entry) => entry.at);
    expect(times.length).toBeGreaterThanOrEqual(3);
    const gaps = times.slice(1).map((at, index) => at - times[index]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1000);
    await jobs.close();
  });

  it("cancel while reading", async () => {
    const { make, seen, listeners, store } = fixture();
    const bots = store.bots.length;
    const jobs = make();
    jobs.start();
    const id = await upload(jobs, { agents: 1, conversations: 5, messagesPer: 2, hangMs: 60_000 });
    const job = await jobs.create({ from: "upload", uploadIds: [id] });
    await waitFor(jobs, listeners, job.id, (view) => view.counts.conversations > 0);
    const started = Date.now();
    const result = await jobs.cancel(job.id);
    expect(Date.now() - started).toBeLessThanOrEqual(2000);
    expect(result.state).toBe("cancelled");
    expect(jobs.get(job.id).state).toBe("cancelled");
    const lateStates = seen.filter((entry) => entry.job.id === job.id && entry.at > started).map((entry) => entry.job.state);
    expect(lateStates.every((state) => state === "cancelled")).toBe(true);
    expect(store.bots.length).toBe(bots);
    expect(importedThreads(store)).toHaveLength(0);
    await jobs.close();
  });

  it("reader error fails the job and writes nothing", async () => {
    const { make, listeners, store } = fixture();
    const bots = store.bots.length;
    const jobs = make();
    jobs.start();
    const id = await upload(jobs, { agents: 1, conversations: 5, messagesPer: 2, throwAfter: 2 });
    const job = await jobs.create({ from: "upload", uploadIds: [id] });
    const failed = await waitFor(jobs, listeners, job.id, (view) => view.state === "failed");
    expect(failed.error).toBe("worker-failed");
    expect(store.bots.length).toBe(bots);
    expect(importedThreads(store)).toHaveLength(0);
    expect(thrown(() => jobs.apply(job.id, { destinations: {} }))).toMatchObject({ status: 409, code: "conflict" });
    await jobs.close();
  });

  it("a worker that cannot start fails the job and does not answer 422", async () => {
    const { make, listeners, store } = fixture({ readersModule: new URL("./testing/missing-readers.ts", import.meta.url).href });
    const bots = store.bots.length;
    const jobs = make();
    jobs.start();
    const id = await upload(jobs, { agents: 1, conversations: 2, messagesPer: 2 });
    const job = await jobs.create({ from: "upload", uploadIds: [id] });
    const failed = await waitFor(jobs, listeners, job.id, (view) => view.state === "failed");
    expect(failed.error).toBe("worker-failed");
    expect(jobs.uploads.get(id)).toBeNull();
    expect(store.bots.length).toBe(bots);
    await jobs.close();
  });

  it("unknown upload", async () => {
    const { make } = fixture();
    const jobs = make();
    jobs.start();
    const id = await upload(jobs, {}, "something-else.json");
    await expect(jobs.create({ from: "upload", uploadIds: [id] })).rejects.toMatchObject({ status: 422, code: "unknown-source" });
    expect(jobs.list()).toHaveLength(0);
    await jobs.close();
  });

  it("undo from ready conflicts", async () => {
    const { make, listeners } = fixture();
    const jobs = make();
    jobs.start();
    const id = await upload(jobs, { agents: 1, conversations: 2, messagesPer: 2 });
    const job = await jobs.create({ from: "upload", uploadIds: [id] });
    await waitFor(jobs, listeners, job.id, (view) => view.state === "ready");
    const error = thrown(() => jobs.undo(job.id));
    expect(error).toBeInstanceOf(ImportJobError);
    expect(error).toMatchObject({ status: 409, code: "conflict" });
    await jobs.close();
  });
});

describe("applying", () => {
  const BIG: FakeScript = { agents: 1, conversations: 20, messagesPer: 10 };

  async function ready(jobs: AiImportJobs, listeners: Set<(job: ImportJobView) => void>, script: FakeScript): Promise<ImportJobView> {
    const id = await upload(jobs, script);
    const job = await jobs.create({ from: "upload", uploadIds: [id] });
    return waitFor(jobs, listeners, job.id, (view) => view.state === "ready");
  }

  it("cancel while applying", async () => {
    const { make, listeners, store } = fixture({ batchSize: 5 });
    const jobs = make();
    jobs.start();
    const job = await ready(jobs, listeners, BIG);
    let asked = false;
    listeners.add((view) => {
      if (view.id === job.id && view.state === "applying" && view.progress.done > 0 && !asked) {
        asked = true;
        void jobs.cancel(job.id);
      }
    });
    jobs.apply(job.id, { destinations: {} });
    const cancelled = await waitFor(jobs, listeners, job.id, (view) => view.state === "cancelled");
    expect(cancelled.report).not.toBeNull();
    expect(cancelled.undoUntil).not.toBeNull();
    const threads = importedThreads(store);
    expect(threads.length).toBeGreaterThan(0);
    expect(threads.length).toBeLessThan(20);
    expect(importedMessages(store)).toBe(cancelled.progress.done);
    expect(cancelled.progress.done).toBeLessThan(200);
    await jobs.close();
  });

  it("resume after restart", async () => {
    const { make, listeners, store } = fixture({ batchSize: 5 });
    const first = make();
    first.start();
    const job = await ready(first, listeners, BIG);
    const closed = new Promise<void>((resolve) => {
      let closing = false;
      listeners.add((view) => {
        if (view.id !== job.id || view.state !== "applying" || view.progress.done === 0 || closing) return;
        closing = true;
        void first.close().then(resolve);
      });
    });
    first.apply(job.id, { destinations: {} });
    await closed;
    const partial = importedMessages(store);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(200);

    const second = make();
    second.start();
    const done = await waitFor(second, listeners, job.id, (view) => view.state === "done");
    expect(done.progress.done).toBe(200);
    expect(importedThreads(store)).toHaveLength(20);
    expect(importedMessages(store)).toBe(200);
    await second.close();
  });

  it("worker crash rolls back", async () => {
    let broken = true;
    let calls = 0;
    const { make, listeners, store } = fixture({ batchSize: 5 }, (ports) => ({
      ...ports,
      threads: {
        ...ports.threads,
        append: (parts) => {
          if (broken && ++calls === 2) throw new Error("The port failed on purpose");
          return ports.threads.append(parts);
        },
      },
    }));
    const bots = store.bots.length;
    const jobs = make();
    jobs.start();
    const job = await ready(jobs, listeners, BIG);
    jobs.apply(job.id, { destinations: {} });
    const failed = await waitFor(jobs, listeners, job.id, (view) => view.state === "failed");
    expect(failed.error).toBe("worker-failed");
    expect(calls).toBe(2);
    expect(store.bots.length).toBe(bots);
    expect(importedThreads(store)).toHaveLength(0);
    expect(importedMessages(store)).toBe(0);

    broken = false;
    jobs.apply(job.id, { destinations: {} });
    const done = await waitFor(jobs, listeners, job.id, (view) => view.state === "done");
    expect(done.error).toBeNull();
    expect(importedThreads(store)).toHaveLength(20);
    expect(importedMessages(store)).toBe(200);
    await jobs.close();
  });
});

describe("paste", () => {
  it("writes about you and how to reply", async () => {
    const { make, listeners, store, harness } = fixture();
    const botId = store.createBot({ name: "Scout" }, { seedMessages: false }).id;
    const jobs = make();
    jobs.start();
    const job = await jobs.create({
      from: "paste", ai: "chatgpt", aboutYou: ["I drink tea at noon"], howToReply: ["Keep answers short"], destination: { kind: "bot", botId },
    });
    const done = await waitFor(jobs, listeners, job.id, (view) => view.state === "done");
    expect(done.source.kind).toBe("paste");
    expect(importedThreads(store)).toHaveLength(0);
    expect(harness.ports.memory.readTopic(botId, "About you from ChatGPT.md")).toContain("I drink tea at noon");
    expect(store.bot(botId)?.soul).toContain("Keep answers short");
    await jobs.close();
  });

  it("too much data", async () => {
    const { make } = fixture();
    const jobs = make();
    jobs.start();
    const error = await jobs.create({
      from: "paste", ai: "other", aboutYou: ["a".repeat(60_000), "b".repeat(40_001)], howToReply: [], destination: { kind: "new" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImportJobError);
    expect(error).toMatchObject({ status: 413, code: "too-much-data" });
    expect(jobs.list()).toHaveLength(0);
    await jobs.close();
  });
});
