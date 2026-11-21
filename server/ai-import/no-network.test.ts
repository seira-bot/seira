import dns from "node:dns";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { emptyCounts } from "../../shared/ai-import/api.ts";
import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { applyChats, applyFastLane, type ApplyContext } from "./apply.ts";
import { ImportDb } from "./db.ts";
import { AiImportJobs } from "./job.ts";
import { runReadPass, type ReadPassMessage } from "./read-pass.ts";
import { SUMMARY_FILE, type ReadSummary } from "./spool.ts";
import type { FakeScript } from "./testing/fake-readers.ts";
import { importHarness } from "./testing/harness.ts";

const READERS_MODULE = new URL("./testing/fake-readers.ts", import.meta.url).href;

let dir: string;
beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "ai-import-net-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await removeTempDir(dir);
});

it("no network", async () => {
  const harness = importHarness();
  const calls: string[] = [];
  const refuse = (name: string) => () => {
    calls.push(name);
    throw new Error(`Network call in a test: ${name}`);
  };
  vi.stubGlobal("fetch", refuse("fetch"));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(refuse("net.Socket.connect"));
  vi.spyOn(http, "request").mockImplementation(refuse("http.request"));
  vi.spyOn(https, "request").mockImplementation(refuse("https.request"));
  vi.spyOn(dns, "lookup").mockImplementation(refuse("dns.lookup"));

  const script: FakeScript = { agents: 2, conversations: 6, messagesPer: 4, leftover: true };
  const upload = join(dir, "upload.json");
  writeFileSync(upload, JSON.stringify(script));
  const staging = join(dir, "staging");
  mkdirSync(staging, { recursive: true });
  const posted: ReadPassMessage[] = [];
  await runReadPass(
    { input: { from: "files", parts: [{ path: upload, name: "fake-export.json" }] }, stagingDir: staging, readersModule: READERS_MODULE },
    (message) => posted.push(message),
    new AbortController().signal,
  );
  expect(posted.at(-1)?.type).toBe("done");

  const summary = JSON.parse(readFileSync(join(staging, SUMMARY_FILE), "utf8")) as ReadSummary;
  const db = new ImportDb(join(dir, "db"));
  db.insertJob({
    id: "net-job", input: { from: "upload", uploadIds: [] }, plan: null, cursor: null,
    view: {
      id: "net-job", source: { kind: "chatgpt" }, state: "applying", createdAt: 0, updatedAt: 0, progress: { done: 0, total: summary.messages, unit: "items" },
      counts: emptyCounts(), agents: [], report: null, undoUntil: null, undoResult: null, error: null,
    },
  });
  const ctx: ApplyContext = {
    jobId: "net-job", db, ports: harness.ports, source: summary.source, label: "ChatGPT", agents: summary.agents,
    destinations: {}, stagingDir: staging, now: Date.now, batchSize: 5,
  };
  const fast = applyFastLane(ctx);
  expect(await applyChats(ctx, fast.bots, { fast: true, conv: 0, msg: 0, done: 0 }, { stop: () => null, progress: () => undefined })).toBe("done");
  db.close();
  expect(harness.store.bots.flatMap((bot) => bot.tasks ?? []).filter((task) => task.imported)).toHaveLength(6);

  const jobs = new AiImportJobs({ dir: join(dir, "jobs"), ports: harness.ports, broadcast: () => undefined, locate: async () => [] });
  try {
    const job = await jobs.create({ from: "paste", ai: "other", aboutYou: ["Likes tea"], howToReply: ["Be brief"], destination: { kind: "new" } });
    for (let i = 0; i < 200 && jobs.get(job.id).state === "applying"; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(jobs.get(job.id).state).toBe("done");
  } finally {
    await jobs.close();
  }

  expect(calls).toEqual([]);
});
