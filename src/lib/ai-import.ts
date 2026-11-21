// Client for the import routes, plus the live job updates from the event stream.
import { listenLiveFrames } from "@/lib/live-events";
import { api } from "@/state/api";
import {
  AI_IMPORT_EVENT, AI_IMPORT_FILE_NAME_HEADER, AI_IMPORT_PATH,
  type ApplyImportJob, type CreateImportJob, type ImportJobView, type LocalSourceView,
} from "../../shared/ai-import/api";

export interface AiImportClient {
  upload(file: Blob, name: string, signal?: AbortSignal): Promise<string>;
  localSources(signal?: AbortSignal): Promise<LocalSourceView[]>;
  create(request: CreateImportJob): Promise<ImportJobView>;
  list(signal?: AbortSignal): Promise<ImportJobView[]>;
  get(id: string, signal?: AbortSignal): Promise<ImportJobView>;
  apply(id: string, request: ApplyImportJob): Promise<ImportJobView>;
  cancel(id: string): Promise<ImportJobView>;
  undo(id: string): Promise<ImportJobView>;
  /** Calls `onJob` for each change to a job. `onMissed` fires when the stream dropped frames, so the caller reads again. */
  subscribe(onJob: (job: ImportJobView) => void, onMissed?: () => void): () => void;
}

const jobPath = (id: string, rest = "") => `${AI_IMPORT_PATH}/jobs/${encodeURIComponent(id)}${rest}`;
const post = (body?: unknown) => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** The frame that carries a job change. The stream names it by `kind`; the shared type names it by `type`. */
export function jobFromFrame(frame: unknown): ImportJobView | null {
  const record = frame as { kind?: unknown; type?: unknown; job?: unknown; event?: unknown } | null;
  if (!record || typeof record !== "object") return null;
  const inner = record.event && typeof record.event === "object" ? (record.event as { type?: unknown; job?: unknown }) : null;
  if (inner && inner.type === AI_IMPORT_EVENT && isJob(inner.job)) return inner.job;
  if ((record.kind === AI_IMPORT_EVENT || record.type === AI_IMPORT_EVENT) && isJob(record.job)) return record.job;
  return null;
}

function isJob(value: unknown): value is ImportJobView {
  const job = value as Partial<ImportJobView> | null;
  return Boolean(job) && typeof job!.id === "string" && typeof job!.state === "string";
}

export const aiImportApi: AiImportClient = {
  async upload(file, name, signal) {
    const sent = await api<{ uploadId: string }>(`${AI_IMPORT_PATH}/uploads`, {
      method: "POST",
      body: file,
      signal,
      headers: { "content-type": "application/octet-stream", [AI_IMPORT_FILE_NAME_HEADER]: encodeURIComponent(name) },
    });
    return sent.uploadId;
  },
  localSources: async (signal) => (await api<{ sources: LocalSourceView[] }>(`${AI_IMPORT_PATH}/local`, { signal })).sources,
  create: (request) => api<ImportJobView>(`${AI_IMPORT_PATH}/jobs`, post(request)),
  list: async (signal) => (await api<{ jobs: ImportJobView[] }>(`${AI_IMPORT_PATH}/jobs`, { signal })).jobs,
  get: (id, signal) => api<ImportJobView>(jobPath(id), { signal }),
  apply: (id, request) => api<ImportJobView>(jobPath(id, "/apply"), post(request)),
  cancel: (id) => api<ImportJobView>(jobPath(id, "/cancel"), post()),
  undo: (id) => api<ImportJobView>(jobPath(id, "/undo"), post()),
  subscribe(onJob, onMissed) {
    return listenLiveFrames({
      onFrame: (frame) => {
        const job = jobFromFrame(frame);
        if (job) onJob(job);
      },
      onMissedFrames: onMissed,
    });
  },
};

export interface DroppedFile {
  file: File;
  /** Path inside a dropped folder, or the file's own name. */
  name: string;
}

type EntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (done: (file: File) => void, fail: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (done: (entries: EntryLike[]) => void, fail: (error: unknown) => void) => void };
};

async function walk(entry: EntryLike, into: DroppedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((done, fail) => entry.file!(done, fail));
    into.push({ file, name: (entry.fullPath ?? entry.name).replace(/^\/+/, "") });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise<EntryLike[]>((done, fail) => reader.readEntries(done, fail));
    if (batch.length === 0) return;
    for (const child of batch) await walk(child, into);
  }
}

/** Every file in a drop, folders included, each with its path inside the dropped folder. */
export async function droppedFiles(transfer: Pick<DataTransfer, "items" | "files">): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const entries = [...transfer.items].map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry?.() ?? null);
  if (entries.length > 0 && entries.every(Boolean)) {
    for (const entry of entries) await walk(entry!, out);
    return out;
  }
  return [...transfer.files].map((file) => ({ file, name: file.name }));
}

/** Files from a file or folder picker, folder files named by their path inside the folder. */
export function pickedFiles(files: FileList | readonly File[]): DroppedFile[] {
  return [...files].map((file) => ({ file, name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
}

/** Uploads one by one, so the server sees them in order. Returns the upload ids in the same order. */
export async function uploadAll(
  client: Pick<AiImportClient, "upload">,
  files: readonly DroppedFile[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const ids: string[] = [];
  for (const { file, name } of files) {
    ids.push(await client.upload(file, name, signal));
    onProgress?.(ids.length, files.length);
  }
  return ids;
}

/** A job that ended, or that waits for the person, so nothing more arrives without a new action. */
export const SETTLED_STATES: ReadonlySet<ImportJobView["state"]> = new Set(["ready", "done", "partly-done", "failed", "undone", "cancelled"]);
