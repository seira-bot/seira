import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { LEGACY_BACKUP_UPLOAD_SUFFIX } from "../electron/legacy-names.mjs";
import { WORKSPACE_BACKUP_CLIENT_KEYS } from "../shared/workspace-backup-client.ts";
import {
  createWorkspaceBackup, stageWorkspaceBackup, commitPendingWorkspaceRestore,
  MAX_WORKSPACE_BACKUP_UPLOAD_BYTES,
  omittedFromWorkspaceBackup,
  removeWorkspaceBackupJob,
  type WorkspaceBackupSummary,
} from "./workspace-backup.ts";
import type { RequestAuth } from "./request-auth.ts";
import { LEAVE_OUT_PARTS, parseLeaveOut, partSizesAsync, singleFlightSizes } from "./workspace-backup-parts.ts";
import { teamCloudBackup } from "./workspace-backup-team-private.ts";
import { userErrorFields } from "./user-errors.ts";

const PREFIX = "/api/workspace-backup";
const MAX_UPLOAD_BYTES = MAX_WORKSPACE_BACKUP_UPLOAD_BYTES;
/** One part of a resumable upload; far under the 100 MB that the Cloudflare edge accepts in one request body. */
const MAX_CHUNK_BYTES = 32 * 1024 ** 2;
const MAX_CLIENT_STATE_BYTES = 2 * 1024 ** 2;
const EXPIRES_MS = 60 * 60_000;
/** setTimeout fires at once for a delay above this. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const passwordSchema = z.string().min(12, "Use a password of at least 12 characters.").max(1024);
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
type Artifact = {
  owner: string; kind: "download" | "upload" | "uploading" | "staged"; path?: string; expires: number; summary?: WorkspaceBackupSummary;
  /** `uploading` only: the announced size, the bytes stored, and whether a part is being written. */
  total?: number; received?: number; writing?: boolean;
};
/** The status shows only how many bots stayed behind. The folder paths stay in the private receipt. */
function leftBehindCount(value: unknown): { bots: number } | null {
  const bots = value && typeof value === "object" ? (value as { bots?: unknown }).bots : undefined;
  return typeof bots === "number" && Number.isSafeInteger(bots) && bots >= 0 ? { bots } : null;
}

type RestoreResult = { id?: string; restored?: boolean; safetyCopyPath?: string; clientState?: Record<string, string>; leftBehind?: unknown; needsAction?: unknown[] | null };

/** One `bytes=a-b`, `a-` or `-n` range; any other header, including a list of ranges, means the whole file. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return undefined;
  let start: number;
  let end: number;
  if (!match[1]) {
    const length = Number(match[2]);
    if (length === 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (match[2] && Number(match[2]) < start) return undefined;
  }
  return start >= size || !Number.isSafeInteger(start) ? "unsatisfiable" : { start, end };
}

export function isWorkspaceBackupSessionControl(method: string, path: string): boolean {
  return (method === "GET" && path === "/api/auth/sessions") ||
    (method === "POST" && path === "/api/auth/logout") ||
    (method === "DELETE" && /^\/api\/auth\/sessions\/[\w-]+$/.test(path));
}

/** Admin-only; passwords and raw credential metadata never appear in URLs, responses, logs or broadcasts. */
export function createWorkspaceBackupRoutes(options: {
  dataDir: string;
  appVersion: string;
  readBody: (req: IncomingMessage, limit?: number) => Promise<unknown>;
  exclusive: <T>(work: () => Promise<T>, keepLocked?: boolean) => Promise<T>;
  authorized: (req: IncomingMessage, auth: RequestAuth) => boolean;
  status: () => { busy: boolean; pendingRestore: boolean };
  restored: RestoreResult;
  /** Starts this server again so startup installs a committed restore. Given only where a launcher always starts it
   * again (My Cloud), since the person there has no app to quit or process to restart. */
  restart?: () => void;
  /** How long a finished export can be read. Default one hour; tests give a short time. */
  exportLifetimeMs?: number;
  /** Signs in a new server to read one export (server/workspace-backup-move-out.ts). */
  moveOut?: {
    issue(exportId: string, expiresAt: number): { token: string };
    revoke(exportId: string): number;
    /** Calls `ended` when sign-in `sessionId` ends, however it ends; returns the way to stop watching. */
    watch(sessionId: string, ended: () => void): () => void;
  };
}) {
  // The report skips the same paths as the export does: it calls the export's own rule.
  const sizesOnce = singleFlightSizes((root) => partSizesAsync(root, [], omittedFromWorkspaceBackup));
  const artifacts = new Map<string, Artifact>();
  let operating = false;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const owner = (auth: RequestAuth) => auth.kind === "session" ? auth.session.id : "local-owner";
  /** A move-out sign-in reads the one export it was made for, whoever made the export. */
  const granted = (auth: RequestAuth, id: unknown) => auth.kind === "session" && typeof id === "string" && auth.session.moveOut === id;
  const check = (req: IncomingMessage, auth: RequestAuth) => {
    if (!options.authorized(req, auth)) throw failure("Your session changed. Reopen Backups and try again.", 403);
  };
  function remove(id: string, artifact: Artifact) {
    if (artifact.path) { try { unlinkSync(artifact.path); } catch {} }
    if (artifact.kind === "download" || artifact.kind === "staged") { try { removeWorkspaceBackupJob(options.dataDir, id); } catch {} }
    artifacts.delete(id);
    options.moveOut?.revoke(id);
  }
  // Reclaim only old app-named jobs, never safety copies or pending/committed recovery state.
  function reclaimAbandoned() {
    const root = join(options.dataDir, ".backups");
    if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      if (statSync(join(root, entry.name)).mtimeMs + EXPIRES_MS > Date.now()) continue;
      try { removeWorkspaceBackupJob(options.dataDir, entry.name); } catch {}
    }
    const uploads = join(root, "uploads");
    if (!existsSync(uploads) || lstatSync(uploads).isSymbolicLink()) return;
    for (const entry of readdirSync(uploads, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}$/.test(entry.name.slice(0, 36)) || ![".seirabackup", LEGACY_BACKUP_UPLOAD_SUFFIX].includes(entry.name.slice(36))) continue;
      const file = join(uploads, entry.name);
      if (statSync(file).mtimeMs + EXPIRES_MS <= Date.now()) { try { unlinkSync(file); } catch {} }
    }
  }
  try { reclaimAbandoned(); } catch {}
  function expire() {
    for (const [id, artifact] of artifacts) {
      if (artifact.expires > Date.now()) continue;
      remove(id, artifact);
    }
  }
  function replacePrevious(auth: RequestAuth, kinds: Artifact["kind"][]) {
    expire();
    for (const [id, artifact] of artifacts) if (artifact.owner === owner(auth) && kinds.includes(artifact.kind)) remove(id, artifact);
  }
  const get = (id: unknown, auth: RequestAuth, kind: Artifact["kind"]) => {
    expire();
    const artifact = typeof id === "string" ? artifacts.get(id) : undefined;
    if (!artifact || !(artifact.owner === owner(auth) || granted(auth, id)) || artifact.kind !== kind) {
      throw failure("This backup has expired or belongs to another session. Select the file again.", 404);
    }
    return artifact;
  };
  function uploadDirectory() {
    const root = join(options.dataDir, ".backups");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw failure("Backup storage must not be a symbolic link.");
    const directory = join(root, "uploads");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw failure("Backup storage must not be a symbolic link.");
    return directory;
  }
  async function operate<T>(work: () => Promise<T>): Promise<T> {
    if (operating) throw failure("Another backup operation is in progress. Wait for it to finish.", 409);
    operating = true;
    try { return await work(); } finally { operating = false; }
  }
  return async (req: IncomingMessage, res: ServerResponse, path: string, auth: RequestAuth): Promise<boolean> => {
    if (!path.startsWith(`${PREFIX}/`)) return false;
    res.setHeader("cache-control", "no-store");
    const method = req.method;
    try {
      check(req, auth);
      if (method === "GET" && path === `${PREFIX}/status`) {
        json(res, 200, {
          ...options.status(),
          ...(options.restart ? { restarts: true } : {}),
          lastRestoreId: options.restored.restored ? options.restored.id : null,
          safetyCopyPath: options.restored.safetyCopyPath ?? null,
          leftBehind: leftBehindCount(options.restored.leftBehind),
          needsAction: options.restored.needsAction ?? null,
        });
        return true;
      }
      if (method === "GET" && path === `${PREFIX}/sizes`) {
        // Read-only: bytes for each part of the data folder, so a person can see what makes a backup large.
        // On a Team Cloud an export leaves out each member's private data, and a count of the raw folder would include it: give no numbers.
        if (teamCloudBackup()) throw failure("Backup sizes are not available on a Team Cloud, because the totals would include other members' private data.", 403);
        const parts = await sizesOnce(options.dataDir);
        json(res, 200, { parts, total: Object.values(parts).reduce((sum, bytes) => sum + bytes, 0), canLeaveOut: [...LEAVE_OUT_PARTS] });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/client-state`) {
        const body = z.object({ restoreId: z.string().uuid() }).parse(await options.readBody(req));
        check(req, auth);
        if (!options.restored.restored || body.restoreId !== options.restored.id) throw failure("This restore has not completed. Restart Seira first.", 409);
        json(res, 200, { clientState: options.restored.clientState ?? {} });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/export`) {
        const body = z.object({ password: passwordSchema, clientState: z.record(z.string(), z.string()).default({}), leaveOut: z.unknown().optional() }).parse(await options.readBody(req, MAX_CLIENT_STATE_BYTES + 8 * 1024));
        if (Buffer.byteLength(JSON.stringify(body.clientState)) > MAX_CLIENT_STATE_BYTES) throw failure("Saved drafts exceed the 2 MB backup preference limit.", 413);
        let leaveOut: string[];
        try { leaveOut = parseLeaveOut(body.leaveOut); } catch (error) { throw failure((error as Error).message); }
        const clientState = Object.fromEntries(Object.entries(body.clientState).filter(([key]) => WORKSPACE_BACKUP_CLIENT_KEYS.includes(key as typeof WORKSPACE_BACKUP_CLIENT_KEYS[number])));
        const result = await operate(() => options.exclusive(async () => {
          check(req, auth);
          replacePrevious(auth, ["download"]);
          if (artifacts.size >= 4) throw failure("There are already four backup files in progress. Restart or wait an hour before creating another.", 409);
          return createWorkspaceBackup(options.dataDir, { password: body.password, clientState, appVersion: options.appVersion, leaveOut });
        }));
        try { check(req, auth); } catch (error) { removeWorkspaceBackupJob(options.dataDir, result.id); throw error; }
        artifacts.set(result.id, { owner: owner(auth), kind: "download", path: result.path, summary: result.summary, expires: Date.now() + (options.exportLifetimeMs ?? EXPIRES_MS) });
        json(res, 200, { id: result.id, filename: `Seira-${result.summary.createdAt.slice(0, 10)}.seirabackup`, bytes: statSync(result.path).size, sha256: result.sha256, summary: result.summary });
        return true;
      }
      const grant = /^\/api\/workspace-backup\/move-out(?:\/([\w-]+))?$/.exec(path);
      if (grant) {
        if (!options.moveOut) throw failure("This server cannot hand a backup to a new server.", 404);
        // A move-out sign-in never makes another; the session check also refuses it before this point.
        if (auth.kind === "session" && auth.session.moveOut) throw failure("This sign-in only reads one backup file.", 403);
        if (method === "POST" && !grant[1]) {
          const body = z.object({ id: z.string().uuid() }).strict().parse(await options.readBody(req));
          check(req, auth);
          const artifact = get(body.id, auth, "download");
          options.moveOut.revoke(body.id);
          const { token } = options.moveOut.issue(body.id, artifact.expires);
          json(res, 200, { token, expiresAt: artifact.expires, path: `${PREFIX}/download/${body.id}` });
          return true;
        }
        if (method === "DELETE" && grant[1]) {
          get(grant[1], auth, "download");
          json(res, 200, { ended: options.moveOut.revoke(grant[1]) });
          return true;
        }
      }
      const download = /^\/api\/workspace-backup\/download\/([\w-]+)$/.exec(path);
      if (method === "GET" && download) {
        const artifact = get(download[1], auth, "download");
        const file = artifact.path!;
        const size = statSync(file).size;
        const range = byteRange(req.headers.range, size);
        // A download under way ends when its sign-in ends, and at the earlier of the export's expiry and the sign-in's
        // expiry, even when nothing else touches the server: only a deadline sees a quiet expiry.
        const stop = new AbortController();
        const endsAt = Math.min(artifact.expires, auth.kind === "session" ? auth.session.expiresAt : Infinity);
        const send = async (source: ReturnType<typeof createReadStream>) => {
          const unwatch = granted(auth, download[1]) && auth.kind === "session" ? options.moveOut?.watch(auth.session.id, () => stop.abort()) : undefined;
          const deadline = setTimeout(() => stop.abort(), Math.min(Math.max(endsAt - Date.now(), 0), MAX_TIMER_MS));
          try { await pipeline(source, res, { signal: stop.signal }); } finally { clearTimeout(deadline); unwatch?.(); }
        };
        const headers = {
          "content-type": "application/octet-stream",
          "accept-ranges": "bytes",
          "content-disposition": `attachment; filename="Seira-${artifact.summary!.createdAt.slice(0, 10)}.seirabackup"`,
          "x-content-type-options": "nosniff",
        };
        if (range === "unsatisfiable") {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
          res.end();
          return true;
        }
        if (range) {
          res.writeHead(206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": range.end - range.start + 1 });
          await send(createReadStream(file, range));
          return true;
        }
        res.writeHead(200, { ...headers, "content-length": size });
        await send(createReadStream(file));
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/upload`) {
        await operate(async () => {
          const length = Number(req.headers["content-length"]);
          if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_UPLOAD_BYTES) throw failure("Select a backup containing no more than 10 GB of workspace data.", 413);
          replacePrevious(auth, ["upload", "uploading", "staged"]);
          if (artifacts.size >= 4) throw failure("There are already four backup files in progress. Restart or wait an hour before uploading another.", 409);
          const directory = uploadDirectory();
          const id = randomUUID();
          const file = join(directory, `${id}.seirabackup`);
          let bytes = 0;
          try {
            const limit = new Transform({ transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              callback(bytes > MAX_UPLOAD_BYTES ? failure("The backup is too large.", 413) : null, chunk);
            } });
            await pipeline(req.iterator({ destroyOnReturn: false }), limit, createWriteStream(file, { flags: "wx", mode: 0o600 }));
            if (bytes !== length) throw failure("The upload was incomplete. Select the file again.");
            check(req, auth);
            artifacts.set(id, { owner: owner(auth), kind: "upload", path: file, expires: Date.now() + EXPIRES_MS });
            json(res, 200, { id });
          } catch (error) { try { unlinkSync(file); } catch {} throw error; }
        });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/upload/start`) {
        const body = z.object({ bytes: z.number().int() }).parse(await options.readBody(req));
        if (body.bytes <= 0 || body.bytes > MAX_UPLOAD_BYTES) throw failure("Select a backup containing no more than 10 GB of workspace data.", 413);
        await operate(async () => {
          replacePrevious(auth, ["upload", "uploading", "staged"]);
          if (artifacts.size >= 4) throw failure("There are already four backup files in progress. Restart or wait an hour before uploading another.", 409);
          const id = randomUUID();
          const file = join(uploadDirectory(), `${id}.seirabackup`);
          writeFileSync(file, "", { flag: "wx", mode: 0o600 });
          artifacts.set(id, { owner: owner(auth), kind: "uploading", path: file, total: body.bytes, received: 0, expires: Date.now() + EXPIRES_MS });
          json(res, 200, { id, chunkBytes: MAX_CHUNK_BYTES });
        });
        return true;
      }
      const resumable = /^\/api\/workspace-backup\/upload\/([\w-]+)(?:\/(chunk|finish))?$/.exec(path);
      if (resumable) {
        const [, id, action] = resumable;
        if (method === "GET" && !action) {
          const artifact = get(id, auth, "uploading");
          json(res, 200, { received: artifact.received, total: artifact.total });
          return true;
        }
        if (method === "POST" && action === "finish") {
          const done = artifacts.get(id)?.kind === "upload";
          const artifact = get(id, auth, done ? "upload" : "uploading");
          if (!done) {
            if (artifact.writing) throw failure("This upload is still receiving data. Try again in a moment.", 409);
            if (artifact.received !== artifact.total || statSync(artifact.path!).size !== artifact.total) throw failure("The upload was incomplete. Select the file again.");
            const expected = new URL(req.url ?? "", "http://localhost").searchParams.get("sha256");
            if (expected !== null) {
              if (!/^[0-9a-f]{64}$/.test(expected)) throw failure("The checksum must be 64 lowercase hexadecimal characters.");
              artifact.writing = true;
              try {
                const actual = createHash("sha256");
                for await (const block of createReadStream(artifact.path!)) actual.update(block);
                if (actual.digest("hex") !== expected) {
                  remove(id, artifact);
                  throw failure("The uploaded file does not match its checksum. Select the file again.", 422);
                }
              } finally { artifact.writing = false; }
            }
            artifact.kind = "upload";
            artifact.expires = Date.now() + EXPIRES_MS;
          }
          json(res, 200, { id });
          return true;
        }
        if (method === "POST" && action === "chunk") {
          const artifact = get(id, auth, "uploading");
          if (artifact.writing) throw failure("This upload is still receiving data. Try again in a moment.", 409);
          const query = new URL(req.url ?? "", "http://localhost").searchParams;
          const offset = Number(query.get("offset"));
          // A proxy may forward the body as Transfer-Encoding: chunked without Content-Length, so the URL carries the size too.
          const declared = [req.headers["content-length"], query.get("bytes")].filter((value): value is string => typeof value === "string").map(Number);
          if (declared.length === 0) throw failure("The size of this part of the backup is missing.", 411);
          if (declared.some((value) => value !== declared[0])) throw failure("The size of this part of the backup does not match.");
          const length = declared[0];
          if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_CHUNK_BYTES) throw failure("This part of the backup is too large.", 413);
          if (!Number.isSafeInteger(offset) || offset !== artifact.received) throw failure("The upload is out of step. Resume it.", 409);
          if (offset + length > artifact.total!) throw failure("The upload is larger than its announced size.", 413);
          artifact.writing = true;
          try {
            let bytes = 0;
            const limit = new Transform({ transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              callback(bytes > length ? failure("The part is larger than announced.", 413) : null, chunk);
            } });
            await pipeline(req.iterator({ destroyOnReturn: false }), limit, createWriteStream(artifact.path!, { flags: "a", mode: 0o600 }));
            if (bytes !== length) throw failure("The upload was incomplete. Resume it.");
            check(req, auth);
            artifact.received = offset + length;
            artifact.expires = Date.now() + EXPIRES_MS;
            json(res, 200, { received: artifact.received });
          } catch (error) {
            try { truncateSync(artifact.path!, artifact.received!); } catch {}
            throw error;
          } finally { artifact.writing = false; }
          return true;
        }
      }
      if (method === "POST" && path === `${PREFIX}/preview`) {
        const body = z.object({ id: z.string().uuid(), password: passwordSchema }).parse(await options.readBody(req));
        const artifact = get(body.id, auth, "upload");
        const result = await operate(() => stageWorkspaceBackup(options.dataDir, artifact.path!, { password: body.password, currentAppVersion: options.appVersion }));
        try { check(req, auth); } catch (error) { removeWorkspaceBackupJob(options.dataDir, result.id); throw error; }
        try { unlinkSync(artifact.path!); } catch {}
        artifacts.delete(body.id);
        artifacts.set(result.id, { owner: owner(auth), kind: "staged", summary: result.summary, expires: Date.now() + EXPIRES_MS });
        json(res, 200, { id: result.id, summary: result.summary });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/restore`) {
        const body = z.object({ id: z.string().uuid(), confirmation: z.literal("REPLACE") }).parse(await options.readBody(req));
        get(body.id, auth, "staged");
        const result = await operate(() => options.exclusive(async () => {
          check(req, auth);
          return commitPendingWorkspaceRestore(options.dataDir, body.id);
        }, true));
        artifacts.delete(body.id);
        const restart = options.restart;
        json(res, 200, { ...result, restoreId: body.id, ...(restart ? { restarting: true } : {}) });
        // Answer first, so the browser knows to wait for the server to come back; restart even if it hung up.
        if (restart) { if (res.closed) restart(); else res.once("close", restart); }
        return true;
      }
      json(res, 404, { error: "Unknown backup operation." });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      json(res, error instanceof z.ZodError ? 400 : (error as { status?: number }).status ?? 400, {
        error: error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid backup request." : error instanceof Error ? error.message : "Backup failed.",
        ...userErrorFields(error),
      });
    }
    return true;
  };
}
