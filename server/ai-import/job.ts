import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  AI_IMPORT_EVENT, emptyCounts,
  type AiImportEvent, type ApplyImportJob, type CreateImportJob, type ImportAgentView, type ImportDestination, type ImportErrorCode,
  type ImportJobView, type LocalSourceView,
} from "../../shared/ai-import/api.ts";
import { emptyAgent, type ImportAgent, type ImportSource } from "../../shared/ai-import/bundle.ts";
import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import { applyChats, applyFastLane, buildReport, type ApplyContext } from "./apply.ts";
import { ImportDb, type ApplyPlan, type JobInput, type JobRow } from "./db.ts";
import { sourceLabel } from "./labels.ts";
import type { ImportPorts } from "./ports.ts";
import type { ReadPassMessage, ReadPassParams, ReadSnapshot } from "./read-pass.ts";
import type { LocalSource } from "./reader.ts";
import { expireReceipts, undoJob } from "./receipts.ts";
import { SUMMARY_FILE, type ReadSummary } from "./spool.ts";
import { createUploadStore, type ImportLimits, type UploadPart } from "./upload.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const UPLOAD_KEEP_MS = DAY;
const PASTE_REF = "paste";

export class ImportJobError extends Error {
  readonly status: number;
  readonly code: ImportErrorCode | "not-found" | "conflict" | "invalid";

  constructor(status: number, code: ImportJobError["code"], message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export interface AiImportJobsOptions {
  /** A private folder in the data folder for the database, uploads and staging copies. */
  dir: string;
  ports: ImportPorts;
  broadcast(event: AiImportEvent): void;
  locate(): Promise<LocalSource[]>;
  now?: () => number;
  /** Tests only: a module that exports READERS in place of the real readers. */
  readersModule?: string;
  heartbeatMs?: number;
  limits?: ImportLimits;
  batchSize?: number;
}

interface ApplyRun {
  stop: "cancel" | "pause" | null;
  promise: Promise<void>;
}

interface ReadRun {
  worker: Worker;
  ended: boolean;
}

function workerSource(): URL {
  for (const name of ["./job.worker.ts", "./job.worker.js", "./ai-import/job.worker.js"]) {
    const url = new URL(name, import.meta.url);
    if (existsSync(url)) return url;
  }
  return new URL("./job.worker.js", import.meta.url);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Jobs that move persona, memory, skills, tools, routines and chats from another AI app into Seira. */
export class AiImportJobs {
  readonly db: ImportDb;
  readonly uploads: ReturnType<typeof createUploadStore>;
  private readonly options: AiImportJobsOptions;
  private readonly now: () => number;
  private readonly reads = new Map<string, ReadRun>();
  private readonly applies = new Map<string, ApplyRun>();
  private readonly located = new Map<string, LocalSource>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: AiImportJobsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    ensurePrivateDir(options.dir);
    this.db = new ImportDb(options.dir);
    this.uploads = createUploadStore(join(options.dir, "uploads"));
  }

  /** Expires old receipts and continues the jobs that a restart stopped. */
  start(): void {
    this.expire();
    for (const row of this.db.jobs()) {
      if (row.view.state === "queued" || row.view.state === "reading") {
        const input = row.input;
        const readable = input.from === "local" || (input.from === "upload" && input.uploadIds.every((uploadId) => this.uploads.get(uploadId) !== null));
        if (readable) this.read(row);
        else this.fail(row.id, "worker-failed");
      } else if (row.view.state === "applying") {
        this.runApply(row.id);
      }
    }
    this.timer = setInterval(() => this.expire(), HOUR);
    this.timer.unref();
  }

  /** Stops each apply after its current batch and each reading pass; the jobs continue at the next start. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const run of this.applies.values()) run.stop ??= "pause";
    await Promise.all([...this.applies.values()].map((run) => run.promise));
    await Promise.all([...this.reads.values()].map((run) => {
      run.ended = true;
      return run.worker.terminate();
    }));
    this.reads.clear();
    this.db.close();
  }

  list(): ImportJobView[] {
    return this.db.jobs().map((row) => row.view);
  }

  get(id: string): ImportJobView {
    const row = this.db.job(id);
    if (!row) throw new ImportJobError(404, "not-found");
    return row.view;
  }

  async localSources(): Promise<LocalSourceView[]> {
    const sources = await this.options.locate();
    this.located.clear();
    for (const source of sources) this.located.set(source.id, source);
    return sources.map((source) => ({ id: source.id, kind: source.kind, name: source.name, ...(source.profile ? { profile: source.profile } : {}) }));
  }

  async create(body: CreateImportJob): Promise<ImportJobView> {
    if (body.from === "paste") return this.createPaste(body);
    if (body.from === "local") {
      if (!this.located.has(body.sourceId)) await this.localSources();
      const source = this.located.get(body.sourceId);
      if (!source) throw new ImportJobError(404, "not-found");
      const row = this.newRow({ kind: source.kind, name: source.name, ...(source.profile ? { profile: source.profile } : {}) }, "reading",
        { from: "local", source, transcripts: body.transcripts === true, instructions: body.instructions ?? "persona" });
      this.db.insertJob(row);
      this.publish(row.view);
      this.read(row);
      return row.view;
    }
    const uploads = body.uploadIds.map((id) => this.uploads.get(id));
    if (!uploads.length || uploads.some((upload) => upload === null)) throw new ImportJobError(404, "not-found");
    const row = this.newRow({ kind: "chatgpt" }, "reading", { from: "upload", uploadIds: body.uploadIds });
    const first = await new Promise<ReadPassMessage>((resolveFirst) => this.read(row, resolveFirst));
    if (first.type === "error") {
      this.removeUploads(row.input);
      throw new ImportJobError(422, first.code);
    }
    return this.get(row.id);
  }

  apply(id: string, body: ApplyImportJob): ImportJobView {
    const row = this.db.job(id);
    if (!row) throw new ImportJobError(404, "not-found");
    const retry = row.view.state === "failed" && row.input.from !== "paste" && existsSync(join(this.staging(id), SUMMARY_FILE));
    if (row.view.state !== "ready" && !retry) throw new ImportJobError(409, "conflict");
    const destinations: Record<string, ImportDestination> = {};
    for (const agent of row.view.agents) {
      const wanted = body.destinations[agent.ref] ?? agent.destination;
      if (wanted.kind === "bot" && !this.options.ports.bots.exists(wanted.botId)) throw new ImportJobError(400, "invalid");
      destinations[agent.ref] = wanted;
    }
    if (Object.keys(body.destinations).some((ref) => !(ref in destinations))) throw new ImportJobError(400, "invalid");
    const view: ImportJobView = {
      ...row.view,
      state: "applying",
      agents: row.view.agents.map((agent) => ({ ...agent, destination: destinations[agent.ref]! })),
      progress: { done: 0, total: row.view.counts.messages, unit: "items" },
      report: null,
      error: null,
      updatedAt: this.now(),
    };
    this.db.transaction(() => {
      this.db.savePlan(id, { destinations });
      this.db.saveCursor(id, { fast: false, conv: 0, msg: 0, done: 0 });
      this.db.saveView(view);
    });
    this.publish(view);
    this.runApply(id);
    return view;
  }

  async cancel(id: string): Promise<ImportJobView> {
    const row = this.db.job(id);
    if (!row) throw new ImportJobError(404, "not-found");
    const state = row.view.state;
    if (state === "applying") {
      const run = this.applies.get(id);
      if (run) run.stop = "cancel";
      return row.view;
    }
    if (state !== "queued" && state !== "reading" && state !== "ready") throw new ImportJobError(409, "conflict");
    const reading = this.reads.get(id);
    if (reading) {
      reading.ended = true;
      reading.worker.postMessage("cancel");
      await reading.worker.terminate();
      this.reads.delete(id);
    }
    this.cleanup(id, row.input);
    return this.save(id, { state: "cancelled" });
  }

  undo(id: string): ImportJobView {
    const row = this.db.job(id);
    if (!row) throw new ImportJobError(404, "not-found");
    const { state, undoUntil } = row.view;
    if ((state !== "done" && state !== "partly-done" && state !== "cancelled") || undoUntil === null || undoUntil <= this.now()) {
      throw new ImportJobError(409, "conflict");
    }
    const undoResult = undoJob(this.db, id, this.options.ports);
    return this.save(id, { state: "undone", undoUntil: null, undoResult });
  }

  /** Deletes receipts older than the Undo time, uploads no job holds, and staging copies of failed jobs. */
  expire(): void {
    for (const view of expireReceipts(this.db, this.now())) this.publish(view);
    this.uploads.sweep(UPLOAD_KEEP_MS, this.now());
    for (const row of this.db.jobs()) {
      if (row.view.state === "failed" && this.now() - row.view.updatedAt > DAY) rmSync(this.staging(row.id), { recursive: true, force: true });
    }
  }

  private staging(id: string): string {
    return join(this.options.dir, "jobs", id);
  }

  private newRow(source: ImportJobView["source"], state: ImportJobView["state"], input: JobInput): JobRow {
    const at = this.now();
    const id = randomUUID();
    return {
      id,
      view: {
        id, source, state, createdAt: at, updatedAt: at, progress: { done: 0, total: null, unit: "items" }, counts: emptyCounts(),
        agents: [], report: null, undoUntil: null, undoResult: null, error: null,
      },
      input,
      plan: null,
      cursor: null,
    };
  }

  private publish(view: ImportJobView): void {
    this.options.broadcast({ type: AI_IMPORT_EVENT, job: view });
  }

  private save(id: string, patch: Partial<ImportJobView>): ImportJobView {
    const row = this.db.job(id)!;
    const view: ImportJobView = { ...row.view, ...patch, updatedAt: this.now() };
    this.db.saveView(view);
    this.publish(view);
    return view;
  }

  private fail(id: string, error: ImportErrorCode): void {
    this.save(id, { state: "failed", error, report: null, undoUntil: null });
  }

  private removeUploads(input: JobInput): void {
    if (input.from === "upload") for (const id of input.uploadIds) this.uploads.remove(id);
  }

  private cleanup(id: string, input: JobInput): void {
    rmSync(this.staging(id), { recursive: true, force: true });
    this.removeUploads(input);
  }

  private defaultDestination(source: ImportSource, ref: string): ImportDestination {
    const stored = this.db.fingerprint({ sourceKind: source.kind, sourceFp: source.fingerprint, itemKey: `${ref}/bot` });
    const botId = text(stored?.target.botId);
    return botId && this.options.ports.bots.exists(botId) ? { kind: "bot", botId } : { kind: "new" };
  }

  private agentViews(snapshot: ReadSnapshot, destination: (ref: string) => ImportDestination): ImportAgentView[] {
    return snapshot.agents.map((agent) => ({ ref: agent.ref, name: agent.name, counts: agent.counts, destination: destination(agent.ref) }));
  }

  /** Runs the reading pass in a worker. `first` gets the first message for an upload job, which has no row until the source is known. */
  private read(row: JobRow, first?: (message: ReadPassMessage) => void): void {
    const id = row.id;
    const stagingDir = this.staging(id);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    let parts: UploadPart[] = [];
    if (row.input.from === "upload") {
      parts = row.input.uploadIds.map((uploadId) => this.uploads.get(uploadId)).filter((upload) => upload !== null).map((upload) => ({ path: upload.path, name: upload.name }));
    }
    const params: ReadPassParams = {
      input: row.input.from === "local" ? { from: "local", source: row.input.source, transcripts: row.input.transcripts, instructions: row.input.instructions ?? "persona" } : { from: "files", parts },
      stagingDir,
      ...(this.options.readersModule ? { readersModule: this.options.readersModule } : {}),
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(this.options.heartbeatMs ? { heartbeatMs: this.options.heartbeatMs } : {}),
    };
    const worker = new Worker(workerSource(), {
      workerData: params,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: AI_IMPORT_LIMITS.workerMemoryMb },
    });
    const run: ReadRun = { worker, ended: false };
    this.reads.set(id, run);
    let inserted = !first;
    let pendingFirst = first;
    const answer = (message: ReadPassMessage) => {
      const resolveFirst = pendingFirst;
      pendingFirst = undefined;
      resolveFirst?.(message);
    };
    const finish = () => {
      run.ended = true;
      this.reads.delete(id);
      void worker.terminate();
    };
    worker.on("message", (message: ReadPassMessage) => {
      if (run.ended) return;
      if (!inserted) {
        if (message.type === "error") {
          finish();
          rmSync(stagingDir, { recursive: true, force: true });
          answer(message);
          return;
        }
        if (message.type !== "sniffed") return;
        this.db.insertJob({ ...row, view: { ...row.view, source: { kind: message.kind } } });
        inserted = true;
        this.publish(this.get(id));
        answer(message);
        return;
      }
      switch (message.type) {
        case "sniffed":
          this.save(id, { source: { ...this.get(id).source, kind: message.kind } });
          break;
        case "progress":
          this.save(id, {
            state: "reading", counts: message.snapshot.counts, progress: message.snapshot.progress,
            agents: this.agentViews(message.snapshot, () => ({ kind: "new" })),
          });
          break;
        case "done": {
          finish();
          this.removeUploads(row.input);
          let summary: ReadSummary;
          try {
            summary = JSON.parse(readFileSync(join(stagingDir, SUMMARY_FILE), "utf8")) as ReadSummary;
          } catch {
            this.cleanup(id, row.input);
            this.fail(id, "worker-failed");
            return;
          }
          const names = new Map(summary.agents.map((agent) => [agent.ref, agent.name]));
          const agents = this.agentViews(message.snapshot, (ref) => this.defaultDestination(summary.source, ref))
            .map((agent) => ({ ...agent, name: names.get(agent.ref) ?? agent.name }));
          this.save(id, {
            state: "ready", counts: message.snapshot.counts, progress: message.snapshot.progress, agents,
            source: { ...this.get(id).source, kind: summary.source.kind, ...(summary.source.profile ? { profile: summary.source.profile } : {}) },
          });
          break;
        }
        case "error":
          finish();
          this.cleanup(id, row.input);
          this.fail(id, message.code);
          break;
      }
    });
    const crashed = () => {
      if (run.ended) return;
      finish();
      if (!inserted) {
        rmSync(stagingDir, { recursive: true, force: true });
        answer({ type: "error", code: "worker-failed" });
        return;
      }
      this.cleanup(id, row.input);
      this.fail(id, "worker-failed");
    };
    worker.on("error", crashed);
    worker.on("exit", crashed);
  }

  private createPaste(body: Extract<CreateImportJob, { from: "paste" }>): ImportJobView {
    const aboutYou = body.aboutYou.map((line) => line.trim()).filter(Boolean);
    const howToReply = body.howToReply.map((line) => line.trim()).filter(Boolean);
    const size = [...aboutYou, ...howToReply].reduce((sum, line) => sum + line.length, 0);
    if (size > AI_IMPORT_LIMITS.pasteChars) throw new ImportJobError(413, "too-much-data");
    if (!aboutYou.length && !howToReply.length) throw new ImportJobError(400, "invalid");
    if (body.destination.kind === "bot" && !this.options.ports.bots.exists(body.destination.botId)) throw new ImportJobError(400, "invalid");
    const input: JobInput = { from: "paste", ai: body.ai, aboutYou, howToReply, destination: body.destination };
    const agent = pasteAgent(input);
    const counts = { ...emptyCounts(), memories: aboutYou.length };
    const row = this.newRow({ kind: "paste", name: sourceLabel("paste", body.ai) }, "applying", input);
    row.view = {
      ...row.view, counts, progress: { done: 0, total: 0, unit: "items" },
      agents: [{ ref: agent.ref, name: agent.name, counts, destination: body.destination }],
    };
    row.plan = { destinations: { [PASTE_REF]: body.destination } };
    row.cursor = { fast: false, conv: 0, msg: 0, done: 0 };
    this.db.insertJob(row);
    this.publish(row.view);
    this.runApply(row.id);
    return row.view;
  }

  private runApply(id: string): void {
    const run: ApplyRun = { stop: null, promise: Promise.resolve() };
    this.applies.set(id, run);
    run.promise = this.applyJob(id, run)
      .catch(() => this.rollBack(id))
      .finally(() => this.applies.delete(id));
  }

  private loadSummary(row: JobRow): ReadSummary {
    if (row.input.from === "paste") {
      return { source: { kind: "paste", fingerprint: `paste:${row.input.ai}` }, agents: [pasteAgent(row.input)], leftovers: [], conversations: 0, messages: 0 };
    }
    return JSON.parse(readFileSync(join(this.staging(row.id), SUMMARY_FILE), "utf8")) as ReadSummary;
  }

  private context(row: JobRow, summary: ReadSummary, plan: ApplyPlan): ApplyContext {
    return {
      jobId: row.id,
      db: this.db,
      ports: this.options.ports,
      source: summary.source,
      label: sourceLabel(summary.source.kind, row.input.from === "paste" ? row.input.ai : undefined),
      agents: summary.agents,
      destinations: plan.destinations,
      stagingDir: row.input.from === "paste" ? null : this.staging(row.id),
      now: this.now,
      ...(this.options.batchSize ? { batchSize: this.options.batchSize } : {}),
    };
  }

  private async applyJob(id: string, run: ApplyRun): Promise<void> {
    await Promise.resolve();
    const row = this.db.job(id)!;
    const summary = this.loadSummary(row);
    let plan: ApplyPlan = row.plan ?? { destinations: {} };
    let cursor = row.cursor ?? { fast: false, conv: 0, msg: 0, done: 0 };
    const ctx = this.context(row, summary, plan);
    if (!cursor.fast || !plan.bots) {
      const fast = applyFastLane(ctx);
      plan = { ...plan, bots: fast.bots, leftovers: fast.leftovers };
      cursor = { ...cursor, fast: true };
      const saved = plan;
      const next = cursor;
      this.db.transaction(() => {
        this.db.savePlan(id, saved);
        this.db.saveCursor(id, next);
      });
    }
    if (run.stop === "pause") return;
    const result = run.stop === "cancel" ? "cancelled" : await applyChats(ctx, plan.bots!, cursor, {
      stop: () => run.stop,
      progress: (done) => { this.save(id, { progress: { done, total: summary.messages, unit: "items" } }); },
    });
    if (result === "paused") return;
    const report = buildReport(ctx, plan.bots!, [...summary.leftovers, ...(plan.leftovers ?? [])]);
    const state = result === "cancelled" ? "cancelled" : report.leftovers.length ? "partly-done" : "done";
    const undoUntil = this.db.receiptCount(id) ? this.now() + AI_IMPORT_LIMITS.undoDays * DAY : null;
    this.db.saveCursor(id, null);
    const doneCount = this.db.job(id)?.view.progress.done ?? 0;
    this.save(id, { state, report, undoUntil, progress: { done: result === "cancelled" ? doneCount : summary.messages, total: summary.messages, unit: "items" } });
    this.cleanup(id, row.input);
  }

  /** A failed apply removes everything the job wrote, so Retry starts from nothing. */
  private rollBack(id: string): void {
    try {
      undoJob(this.db, id, this.options.ports, { force: true });
    } catch {
    }
    this.db.saveCursor(id, null);
    this.fail(id, "worker-failed");
  }
}

function pasteAgent(input: Extract<JobInput, { from: "paste" }>): ImportAgent {
  const agent = emptyAgent(PASTE_REF, sourceLabel("paste", input.ai));
  agent.aboutYou = input.aboutYou.map((line, index) => ({ ref: `about-${index}`, text: line }));
  agent.howToReply = input.howToReply.map((line, index) => ({ ref: `reply-${index}`, text: line }));
  return agent;
}
