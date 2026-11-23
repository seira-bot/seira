import { t } from "@/lib/i18n";

/** A single request body above about 100 MB is dropped by the Cloudflare edge; the server accepts at most 32 MiB per part. */
export const CLIENT_CHUNK_BYTES = 16 * 1024 ** 2;
const FAILURES_IN_A_ROW = 4;
const RETRY_WAIT_MS = 1_000;
const PART_TIMEOUT_MS = 5 * 60_000;
const BASE = "/api/workspace-backup/upload";

type Api = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: BodyInit; timeoutMs?: number }) => Promise<any>;
type Options = {
  api: Api;
  onProgress: (percent: number) => void;
  /** An earlier upload of the same file: continue from the bytes the server already holds. */
  resumeId?: string | null;
  onStarted?: (id: string) => void;
  wait?: (ms: number) => Promise<void>;
  chunkBytes?: number;
};

const statusOf = (cause: unknown): number | undefined => typeof (cause as { status?: unknown })?.status === "number" ? (cause as { status: number }).status : undefined;
/** A dropped connection, a timeout, or a busy or failing gateway can pass; any other refusal stays. */
const retryable = (cause: unknown) => {
  const status = statusOf(cause);
  return status === undefined || status >= 500 || [408, 409, 425, 429].includes(status);
};

/** Sends `file` to the server in small ordered parts and returns the id that validation takes. After a failed part it
 * waits, asks the server how many bytes it holds, and continues from there. */
export async function uploadBackupInChunks(file: Blob, options: Options): Promise<string> {
  const { api, onProgress } = options;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const percent = (bytes: number) => Math.floor((bytes / file.size) * 100);
  let chunkBytes = options.chunkBytes ?? CLIENT_CHUNK_BYTES;
  let failures = 0;
  const failed = async (cause: unknown) => {
    if (!retryable(cause)) throw cause;
    if (++failures >= FAILURES_IN_A_ROW) throw new Error(t("backup.uploadFailed"));
    await wait(RETRY_WAIT_MS * failures);
  };

  let id: string | null = options.resumeId ?? null;
  let received = 0;
  if (id) {
    try { received = (await api(`${BASE}/${id}`)).received; }
    catch { id = null; }
  }
  while (id === null) {
    try {
      const started = await api(`${BASE}/start`, { method: "POST", body: JSON.stringify({ bytes: file.size }) });
      id = started.id;
      received = 0;
      if (typeof started.chunkBytes === "number") chunkBytes = Math.min(chunkBytes, started.chunkBytes);
      options.onStarted?.(started.id);
    } catch (cause) { await failed(cause); }
  }
  onProgress(percent(received));

  while (received < file.size) {
    const end = Math.min(received + chunkBytes, file.size);
    try {
      await api(`${BASE}/${id}/chunk?offset=${received}&bytes=${end - received}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: file.slice(received, end), timeoutMs: PART_TIMEOUT_MS,
      });
      received = end;
      failures = 0;
    } catch (cause) {
      await failed(cause);
      try { received = (await api(`${BASE}/${id}`)).received; } catch (again) { await failed(again); }
    }
    onProgress(percent(received));
  }

  for (;;) {
    try { await api(`${BASE}/${id}/finish`, { method: "POST" }); return id; }
    catch (cause) { await failed(cause); }
  }
}
