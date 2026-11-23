// This server's access to the push relay (cloudflare/push-relay, `push.seira.bot`). The relay has no accounts: a server
// enrolls itself once, keeps the installation credential it gets in a 0600 file under its data folder, and rotates it
// before its 90 days end. Security invariant: the credential travels only in the Authorization header, only to the
// relay origin that issued it, and is never logged.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { normalizeControlPlaneURL } from "../electron/control-plane-client.mjs";
import { LIVE_SEIRA_SERVICES, SEIRA_HOSTS, seiraOrigin, type SeiraService } from "../electron/seira-hosts.mjs";
import { writeFileAtomic } from "./atomic.ts";

export const PUSH_RELAY_URL_ENV = "SEIRA_PUSH_RELAY_URL";
/** A credential the relay issued elsewhere, for a server that must not enroll itself. */
export const PUSH_CREDENTIAL_ENV = "SEIRA_PUSH_CREDENTIAL";
export const PUSH_RELAY_FILE = "push-relay.json";
export const PUSH_RELAY_ACCESS_PATHS = {
  enroll: "/v1/push/enroll",
  rotate: "/v1/installations/self/credentials/rotate",
} as const;

const DAY_MS = 24 * 60 * 60_000;
export const ROTATE_BEFORE_MS = 30 * DAY_MS;
export const PUSH_ACCESS_CHECK_MS = 12 * 60 * 60_000;
export const ENROLL_RETRY_MIN_MS = 60_000;
export const ENROLL_RETRY_MAX_MS = 6 * 60 * 60_000;
const RETRY_AFTER_MAX_MS = DAY_MS;
const RELAY_TIMEOUT_MS = 10_000;

export const INSTALLATION_CREDENTIAL = /^seira_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
/** The relay's error codes are snake_case words; anything else in that field is not written to the log. */
const LOGGED_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export interface PhonePushAccess {
  relay: string;
  credential: string;
}

export interface RelayAnswer {
  status: number;
  code?: string;
  retryAfterMs?: number;
  body?: unknown;
}

/** SEIRA_PUSH_RELAY_URL when it is set (an invalid value turns push off), else Seira's relay once it is live. */
export function pushRelayOrigin(env: NodeJS.ProcessEnv = process.env, live: readonly SeiraService[] = LIVE_SEIRA_SERVICES): string {
  const override = env[PUSH_RELAY_URL_ENV]?.trim();
  if (override) return normalizeControlPlaneURL(override);
  return live.includes("push") ? seiraOrigin(SEIRA_HOSTS.push) : "";
}

/** One POST to the relay; null when it could not be reached. */
export async function postToRelay(fetchImpl: typeof fetch, relay: string, path: string, body: unknown, credential?: string): Promise<RelayAnswer | null> {
  try {
    const response = await fetchImpl(`${relay}${path}`, {
      method: "POST",
      headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => null);
    const error = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      body: payload,
      ...(typeof error === "string" ? { code: error } : {}),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
    };
  } catch {
    return null;
  }
}

const credential = z.string().regex(INSTALLATION_CREDENTIAL);
const expiresAt = z.number().int().positive();
const savedSchema = z.object({ version: z.literal(1), relay: z.string(), installationId: z.string().max(128), credential, expiresAt }).strict();
const enrolledSchema = z.object({ installationId: z.string().min(1).max(128), credential, expiresAt });
const rotatedSchema = z.object({ credential, expiresAt });
type Saved = z.infer<typeof savedSchema>;

export interface PhonePushAccessOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  live?: readonly SeiraService[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export class PhonePushAccessSource {
  readonly relay: string;
  private saved: Saved | null = null;
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private failures = 0;
  private retryAt = 0;
  private running: Promise<void> | null = null;

  constructor(options: PhonePushAccessOptions) {
    this.env = options.env ?? process.env;
    this.relay = pushRelayOrigin(this.env, options.live);
    this.file = join(options.dataDir, PUSH_RELAY_FILE);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const parsed = savedSchema.safeParse(raw);
    if (parsed.success) this.saved = parsed.data;
    else this.log("[phone-push] the saved push relay credential could not be read; this computer enrolls again");
  }

  private fromEnv(): string | undefined {
    return this.env[PUSH_CREDENTIAL_ENV]?.trim() || undefined;
  }

  private usable(): Saved | null {
    const saved = this.saved;
    return saved && saved.relay === this.relay && saved.expiresAt > this.now() ? saved : null;
  }

  /** The relay and the credential to use there now, or null. */
  current(): PhonePushAccess | null {
    if (!this.relay) return null;
    const fromEnv = this.fromEnv();
    if (fromEnv) return INSTALLATION_CREDENTIAL.test(fromEnv) ? { relay: this.relay, credential: fromEnv } : null;
    const saved = this.usable();
    return saved ? { relay: this.relay, credential: saved.credential } : null;
  }

  /** Enrolls when there is no usable credential and rotates one that ends within ROTATE_BEFORE_MS. One call at a time;
   * never throws. */
  ensure(): Promise<void> {
    this.running ??= this.refresh()
      .catch((error: unknown) => this.log(`[phone-push] could not renew the push relay credential: ${error instanceof Error ? error.name : "error"}`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** The relay answered 401 to `credential`. True when that was the saved one: it is dropped and a new one enrolled. */
  refused(credential: string): boolean {
    if (this.fromEnv() || this.saved?.credential !== credential) return false;
    this.saved = null;
    this.wait(null);
    return true;
  }

  private async refresh(): Promise<void> {
    if (!this.relay || this.fromEnv() || this.now() < this.retryAt) return;
    const saved = this.usable();
    if (!saved) return this.enroll();
    if (saved.expiresAt - this.now() > ROTATE_BEFORE_MS) return;
    return this.rotate(saved);
  }

  private async enroll(): Promise<void> {
    const answer = await postToRelay(this.fetchImpl, this.relay, PUSH_RELAY_ACCESS_PATHS.enroll, { v: 1 });
    const enrolled = answer?.status === 201 ? enrolledSchema.safeParse(answer.body) : null;
    if (!enrolled?.success) return this.failed("enroll", answer);
    this.save({ version: 1, relay: this.relay, ...enrolled.data });
    this.log("[phone-push] this computer enrolled with the push relay");
  }

  private async rotate(saved: Saved): Promise<void> {
    const answer = await postToRelay(this.fetchImpl, this.relay, PUSH_RELAY_ACCESS_PATHS.rotate, undefined, saved.credential);
    if (answer?.status === 401) {
      this.saved = null;
      return this.enroll();
    }
    const rotated = answer?.status === 200 ? rotatedSchema.safeParse(answer.body) : null;
    if (!rotated?.success) return this.failed("rotate", answer);
    this.save({ ...saved, ...rotated.data });
  }

  private save(next: Saved): void {
    this.saved = next;
    this.failures = 0;
    this.retryAt = 0;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  private wait(answer: RelayAnswer | null): number {
    this.failures += 1;
    const backoff = Math.min(ENROLL_RETRY_MIN_MS * 2 ** (this.failures - 1), ENROLL_RETRY_MAX_MS);
    const wait = answer?.retryAfterMs ? Math.min(Math.max(answer.retryAfterMs, ENROLL_RETRY_MIN_MS), RETRY_AFTER_MAX_MS) : backoff;
    this.retryAt = this.now() + wait;
    return wait;
  }

  private failed(step: "enroll" | "rotate", answer: RelayAnswer | null): void {
    const wait = this.wait(answer);
    const code = answer?.code && LOGGED_CODE.test(answer.code) ? ` ${answer.code}` : "";
    const why = answer ? `${answer.status}${code}` : "unreachable";
    this.log(`[phone-push] push relay ${step} failed (${why}); next try in ${Math.ceil(wait / 60_000)} min`);
  }
}
