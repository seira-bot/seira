// Anonymous card counts for Seira Cloud. A page posts { id, action } to its own server; the server keeps them in memory
// and sends them in one batch. Nothing of the person goes with a batch, and nothing is written to disk.
import {
  ANNOUNCEMENT_COUNT_ACTIONS, CLOUD_ANNOUNCEMENT_EVENTS_URL, LIMITS, type AnnouncementCountAction,
} from "../../shared/announcements.ts";
import { ANNOUNCEMENTS_DISABLE_ENV, announcementStore, cloudAnnouncementStore } from "./feed.ts";

/** "1" stops the count on this server; the card feed itself is governed by SEIRA_DISABLE_ANNOUNCEMENTS. */
export const ANNOUNCEMENT_COUNTS_DISABLE_ENV = "SEIRA_DISABLE_ANNOUNCEMENT_COUNTS";
export const COUNTS_FLUSH_MS = 60_000;
export const COUNTS_BATCH_MAX = 50;
export const COUNTS_QUEUE_MAX = 200;
export const COUNTS_FETCH_TIMEOUT_MS = 10_000;
/** The longest a "retry-after" from the Cloud can push the next send. */
export const COUNTS_RETRY_AFTER_MAX_MS = 60 * 60 * 1000;

export interface AnnouncementCountEvent {
  id: string;
  action: AnnouncementCountAction;
}

/** The event in a request body, or null when it has the wrong shape. */
export function parseCountEvent(body: unknown): AnnouncementCountEvent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { id, action } = body as Record<string, unknown>;
  if (typeof id !== "string" || id.length < 1 || id.length > LIMITS.id) return null;
  if (typeof action !== "string" || !(ANNOUNCEMENT_COUNT_ACTIONS as readonly string[]).includes(action)) return null;
  return { id, action: action as AnnouncementCountAction };
}

export interface AnnouncementCounterOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** The ids of the cards this server serves now, from both stores. */
  servedIds?: () => ReadonlySet<string>;
  url?: string;
  flushMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

const servedNow = (): ReadonlySet<string> => new Set([...announcementStore().cards(), ...cloudAnnouncementStore().cards()].map((card) => card.id));

export class AnnouncementCounter {
  private readonly options: AnnouncementCounterOptions;
  private queue: AnnouncementCountEvent[] = [];
  private retry: AnnouncementCountEvent[] | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;

  constructor(options: AnnouncementCounterOptions = {}) {
    this.options = options;
  }

  get disabled(): boolean {
    const env = this.options.env ?? process.env;
    return env[ANNOUNCEMENTS_DISABLE_ENV] === "1" || env[ANNOUNCEMENT_COUNTS_DISABLE_ENV] === "1";
  }

  /** Queues the event when this server serves the card; drops it otherwise. Returns whether it was queued. */
  record(event: AnnouncementCountEvent): boolean {
    if (this.disabled || !(this.options.servedIds ?? servedNow)().has(event.id)) return false;
    this.queue.push(event);
    if (this.queue.length > COUNTS_QUEUE_MAX) this.queue.splice(0, this.queue.length - COUNTS_QUEUE_MAX);
    if (this.queue.length >= COUNTS_BATCH_MAX) void this.flush();
    else this.schedule(this.options.flushMs ?? COUNTS_FLUSH_MS);
    return true;
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, ms);
    this.timer.unref?.();
  }

  /** Sends one batch: the batch that failed last time if there is one, else the oldest queued events. Never throws. */
  flush(): Promise<void> {
    this.sending ??= this.send().finally(() => { this.sending = undefined; });
    return this.sending;
  }

  private async send(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.disabled) { this.queue = []; this.retry = null; return; }
    const retried = this.retry !== null;
    const batch = this.retry ?? this.queue.splice(0, COUNTS_BATCH_MAX);
    this.retry = null;
    let delayMs = this.options.flushMs ?? COUNTS_FLUSH_MS;
    if (batch.length) {
      const outcome = await this.post(batch);
      if (outcome.failed && !retried) this.retry = batch;
      if (outcome.failed && outcome.retryAfterMs) delayMs = Math.max(delayMs, outcome.retryAfterMs);
    }
    if (this.queue.length >= COUNTS_BATCH_MAX && !this.retry) void this.flush();
    else if (this.queue.length || this.retry) this.schedule(delayMs);
  }

  private async post(batch: AnnouncementCountEvent[]): Promise<{ failed: boolean; retryAfterMs?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? COUNTS_FETCH_TIMEOUT_MS);
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url ?? CLOUD_ANNOUNCEMENT_EVENTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Seira" },
        body: JSON.stringify({ events: batch.map(({ id, action }) => ({ id, action })) }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
      void response.body?.cancel().catch(() => {});
      if (response.status === 204) return { failed: false };
      // A batch the Cloud refused as malformed or too large cannot succeed on a second try.
      if (response.status === 400 || response.status === 413) return { failed: false };
      const seconds = Number(response.headers.get("retry-after"));
      return { failed: true, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, COUNTS_RETRY_AFTER_MAX_MS) : undefined };
    } catch (error) {
      (this.options.log ?? ((line: string) => console.warn(line)))(`[announcements:counts] could not send the counts (${error instanceof Error ? error.message : String(error)})`);
      return { failed: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

let counter: AnnouncementCounter | undefined;

export function announcementCounter(): AnnouncementCounter {
  return counter ??= new AnnouncementCounter();
}
