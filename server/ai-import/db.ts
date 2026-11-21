import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ImportLeftover, ImportSourceKind } from "../../shared/ai-import/bundle.ts";
import type { ImportDestination, ImportJobView, InstructionsAs, PasteSource } from "../../shared/ai-import/api.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import type { LocalSource } from "./reader.ts";

/** The source of a local job stays on the server; the hub only ever holds its opaque id. */
export type JobInput =
  | { from: "upload"; uploadIds: string[] }
  | { from: "local"; source: LocalSource; transcripts: boolean; instructions: InstructionsAs }
  | { from: "paste"; ai: PasteSource; aboutYou: string[]; howToReply: string[]; destination: ImportDestination };

/** `bots` and `leftovers` come from the fast lane, so a restarted job goes on with the chats. */
export interface ApplyPlan {
  destinations: Record<string, ImportDestination>;
  bots?: Record<string, string>;
  leftovers?: ImportLeftover[];
}

/** `conv` is the index of the next conversation in the spool, `msg` the next message in it, and `done` the messages written so far. */
export interface ApplyCursor {
  fast: boolean;
  conv: number;
  msg: number;
  done?: number;
}

export interface JobRow {
  id: string;
  view: ImportJobView;
  input: JobInput;
  plan: ApplyPlan | null;
  cursor: ApplyCursor | null;
}

export type ReceiptKind =
  | "bot" | "persona" | "topic" | "memory" | "daily" | "skill" | "tool" | "routine" | "conversation";

export interface FingerprintKey {
  sourceKind: ImportSourceKind;
  sourceFp: string;
  itemKey: string;
}

export interface Fingerprint extends FingerprintKey {
  contentHash: string;
  target: Record<string, unknown>;
  written: string;
  jobId: string;
  at: number;
}

export interface ReceiptInput {
  itemKey: string;
  kind: ReceiptKind;
  action: "added" | "updated";
  keptBoth?: boolean;
  target: Record<string, unknown>;
  before: unknown;
  written: string;
  name: string;
  fingerprint: FingerprintKey | null;
  previous: Fingerprint | null;
}

export interface Receipt extends ReceiptInput {
  jobId: string;
  seq: number;
}

interface JobRecord { id: string; view: string; input: string; plan: string | null; cursor: string | null }
interface ReceiptRecord {
  job_id: string; seq: number; item_key: string; kind: string; action: string; kept_both: number;
  target: string; before: string | null; written: string; name: string; fingerprint: string | null; previous: string | null;
}
interface FingerprintRecord {
  source_kind: string; source_fp: string; item_key: string; content_hash: string; target: string; written: string; job_id: string; at: number;
}

const parse = <T>(text: string | null): T | null => (text === null ? null : JSON.parse(text) as T);

function receiptFrom(row: ReceiptRecord): Receipt {
  return {
    jobId: row.job_id,
    seq: row.seq,
    itemKey: row.item_key,
    kind: row.kind as ReceiptKind,
    action: row.action === "updated" ? "updated" : "added",
    ...(row.kept_both ? { keptBoth: true } : {}),
    target: JSON.parse(row.target) as Record<string, unknown>,
    before: parse<unknown>(row.before),
    written: row.written,
    name: row.name,
    fingerprint: parse<FingerprintKey>(row.fingerprint),
    previous: parse<Fingerprint>(row.previous),
  };
}

function fingerprintFrom(row: FingerprintRecord): Fingerprint {
  return {
    sourceKind: row.source_kind as ImportSourceKind,
    sourceFp: row.source_fp,
    itemKey: row.item_key,
    contentHash: row.content_hash,
    target: JSON.parse(row.target) as Record<string, unknown>,
    written: row.written,
    jobId: row.job_id,
    at: row.at,
  };
}

/** Jobs, receipts and fingerprints of imports from other AI apps, in their own database file. */
export class ImportDb {
  readonly db: DatabaseSync;

  constructor(dir: string) {
    ensurePrivateDir(dir);
    const file = join(dir, "import.db");
    this.db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch {}
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        view TEXT NOT NULL,
        input TEXT NOT NULL,
        plan TEXT,
        cursor TEXT
      );
      CREATE TABLE IF NOT EXISTS receipts (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        kept_both INTEGER NOT NULL DEFAULT 0,
        target TEXT NOT NULL,
        before TEXT,
        written TEXT NOT NULL,
        name TEXT NOT NULL,
        fingerprint TEXT,
        previous TEXT,
        PRIMARY KEY (job_id, seq),
        UNIQUE (job_id, item_key)
      );
      CREATE TABLE IF NOT EXISTS fingerprints (
        source_kind TEXT NOT NULL,
        source_fp TEXT NOT NULL,
        item_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        target TEXT NOT NULL,
        written TEXT NOT NULL,
        job_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_fp, item_key)
      );
    `);
  }

  close(): void {
    try { this.db.close(); } catch {}
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertJob(row: JobRow): void {
    this.db.prepare("INSERT INTO jobs (id, created_at, view, input, plan, cursor) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.view.createdAt, JSON.stringify(row.view), JSON.stringify(row.input), row.plan ? JSON.stringify(row.plan) : null, row.cursor ? JSON.stringify(row.cursor) : null);
  }

  saveView(view: ImportJobView): void {
    this.db.prepare("UPDATE jobs SET view = ? WHERE id = ?").run(JSON.stringify(view), view.id);
  }

  savePlan(id: string, plan: ApplyPlan): void {
    this.db.prepare("UPDATE jobs SET plan = ? WHERE id = ?").run(JSON.stringify(plan), id);
  }

  saveCursor(id: string, cursor: ApplyCursor | null): void {
    this.db.prepare("UPDATE jobs SET cursor = ? WHERE id = ?").run(cursor ? JSON.stringify(cursor) : null, id);
  }

  job(id: string): JobRow | null {
    const row = this.db.prepare("SELECT id, view, input, plan, cursor FROM jobs WHERE id = ?").get(id) as JobRecord | undefined;
    return row ? this.jobFrom(row) : null;
  }

  jobs(): JobRow[] {
    return (this.db.prepare("SELECT id, view, input, plan, cursor FROM jobs ORDER BY created_at DESC").all() as unknown as JobRecord[])
      .map((row) => this.jobFrom(row));
  }

  private jobFrom(row: JobRecord): JobRow {
    return {
      id: row.id,
      view: JSON.parse(row.view) as ImportJobView,
      input: JSON.parse(row.input) as JobInput,
      plan: parse<ApplyPlan>(row.plan),
      cursor: parse<ApplyCursor>(row.cursor),
    };
  }

  /** Returns the receipt that holds `itemKey` for this job: the stored one when it was written before. */
  addReceipt(jobId: string, input: ReceiptInput): Receipt {
    const existing = this.receipt(jobId, input.itemKey);
    if (existing) return existing;
    const next = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM receipts WHERE job_id = ?").get(jobId) as { seq: number }).seq;
    this.db.prepare(`INSERT INTO receipts (job_id, seq, item_key, kind, action, kept_both, target, before, written, name, fingerprint, previous)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(jobId, next, input.itemKey, input.kind, input.action, input.keptBoth ? 1 : 0, JSON.stringify(input.target),
        input.before === undefined || input.before === null ? null : JSON.stringify(input.before), input.written, input.name,
        input.fingerprint ? JSON.stringify(input.fingerprint) : null, input.previous ? JSON.stringify(input.previous) : null);
    return { ...input, jobId, seq: next };
  }

  updateReceipt(jobId: string, itemKey: string, patch: { written?: string; target?: Record<string, unknown> }): void {
    if (patch.written !== undefined) this.db.prepare("UPDATE receipts SET written = ? WHERE job_id = ? AND item_key = ?").run(patch.written, jobId, itemKey);
    if (patch.target !== undefined) this.db.prepare("UPDATE receipts SET target = ? WHERE job_id = ? AND item_key = ?").run(JSON.stringify(patch.target), jobId, itemKey);
  }

  receipt(jobId: string, itemKey: string): Receipt | null {
    const row = this.db.prepare("SELECT * FROM receipts WHERE job_id = ? AND item_key = ?").get(jobId, itemKey) as ReceiptRecord | undefined;
    return row ? receiptFrom(row) : null;
  }

  receipts(jobId: string): Receipt[] {
    return (this.db.prepare("SELECT * FROM receipts WHERE job_id = ? ORDER BY seq").all(jobId) as unknown as ReceiptRecord[]).map(receiptFrom);
  }

  receiptCount(jobId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE job_id = ?").get(jobId) as { n: number }).n;
  }

  deleteReceipts(jobId: string): void {
    this.db.prepare("DELETE FROM receipts WHERE job_id = ?").run(jobId);
  }

  fingerprint(key: FingerprintKey): Fingerprint | null {
    const row = this.db.prepare("SELECT * FROM fingerprints WHERE source_kind = ? AND source_fp = ? AND item_key = ?")
      .get(key.sourceKind, key.sourceFp, key.itemKey) as FingerprintRecord | undefined;
    return row ? fingerprintFrom(row) : null;
  }

  putFingerprint(fp: Fingerprint): void {
    this.db.prepare(`INSERT INTO fingerprints (source_kind, source_fp, item_key, content_hash, target, written, job_id, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_kind, source_fp, item_key) DO UPDATE SET
        content_hash = excluded.content_hash, target = excluded.target, written = excluded.written, job_id = excluded.job_id, at = excluded.at`)
      .run(fp.sourceKind, fp.sourceFp, fp.itemKey, fp.contentHash, JSON.stringify(fp.target), fp.written, fp.jobId, fp.at);
  }

  deleteFingerprint(key: FingerprintKey): void {
    this.db.prepare("DELETE FROM fingerprints WHERE source_kind = ? AND source_fp = ? AND item_key = ?").run(key.sourceKind, key.sourceFp, key.itemKey);
  }
}
