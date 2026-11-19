import type { EngineLiveVoiceEvent, EngineLiveVoiceSession } from "./contracts.ts";
import type { LiveSocket } from "./live-call-controller.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
const NORMAL_CLOSE = 1000;
const UNEXPECTED_CLOSE = 1011;
/** Transcript deltas of one utterance arrive closer together than this. */
const UTTERANCE_GAP_MS = 1_500;
const MAX_HELD_FRAMES = 200;
const ACTIVITY_FRAME_GAP_MS = 1_000;
const KNOWN_CLOSE_REASONS = new Set(["expired", "content", "remote_hangup", "connection_lost"]);

type Voice = { endMs: number; at: number };

export interface LiveCodexSocketOptions {
  now?(): number;
  /** Runs once, when the socket has closed. */
  onClosed?(): void;
  /** Receives the stop of the session when it begins, so a caller can wait for it after the socket has closed. */
  onStop?(stop: Promise<void>): void;
}

/** Presents a Codex voice session to the Live call controller as the sideband socket of a GPT-Live call. */
export class LiveCodexSocket implements LiveSocket {
  readyState = CONNECTING;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private openHandler: ((event: unknown) => void) | null = null;
  private opened = false;
  private openDelivered = false;
  private messageHandler: ((event: { data: unknown }) => void) | null = null;
  private held: string[] = [];
  private session: EngineLiveVoiceSession | null = null;
  private stopRequested = false;
  private stopPromise: Promise<void> | null = null;
  private closeDelivered = false;
  private engineClosed = false;
  private lastActivityFrameAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly onClosed: (() => void) | undefined;
  private readonly onStop: ((stop: Promise<void>) => void) | undefined;
  private readonly createdAt: number;
  private readonly voices: Record<"user" | "assistant", Voice | null> = { user: null, assistant: null };

  constructor(options: LiveCodexSocketOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onClosed = options.onClosed;
    this.onStop = options.onStop;
    this.createdAt = this.now();
  }

  get onopen(): ((event: unknown) => void) | null {
    return this.openHandler;
  }

  set onopen(handler: ((event: unknown) => void) | null) {
    this.openHandler = handler;
    if (!handler || !this.opened || this.openDelivered || this.readyState !== OPEN) return;
    this.openDelivered = true;
    queueMicrotask(() => {
      if (this.readyState === OPEN) this.openHandler?.({});
    });
  }

  get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.messageHandler;
  }

  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.messageHandler = handler;
    if (handler && this.held.length) queueMicrotask(() => this.flushHeld());
  }

  /** The engine ended the call, by closing it or by failing, as opposed to the caller closing the socket. */
  get closedByEngine(): boolean {
    return this.engineClosed;
  }

  attach(session: EngineLiveVoiceSession): void {
    this.session = session;
    if (this.stopRequested) void this.stopSession();
  }

  event(event: EngineLiveVoiceEvent): void {
    if (this.readyState === CLOSED || this.stopRequested) return;
    switch (event.type) {
      case "started":
        if (this.opened) return;
        this.opened = true;
        this.readyState = OPEN;
        if (this.openHandler) {
          this.openDelivered = true;
          this.openHandler({});
        }
        this.frame({ type: "session.started" });
        return;
      case "transcript": {
        const { startMs, endMs } = this.timing(event.role);
        this.frame({
          type: event.role === "user" ? "session.input_transcript.delta" : "session.output_transcript.delta",
          delta: event.delta,
          start_ms: startMs,
          end_ms: endMs,
        });
        return;
      }
      case "closed": {
        this.engineClosed = true;
        const reason = event.reason ?? "";
        this.frame({ type: "session.closed", reason: KNOWN_CLOSE_REASONS.has(reason) ? reason : "remote_hangup" });
        this.finishClose(NORMAL_CLOSE);
        void this.stopSession();
        return;
      }
      case "failed":
        this.engineClosed = true;
        this.frame({ type: "error", error: { code: event.reason } });
        this.finishClose(UNEXPECTED_CLOSE);
        void this.stopSession();
        return;
      case "working": {
        const at = this.now();
        if (at - this.lastActivityFrameAt < ACTIVITY_FRAME_GAP_MS) return;
        this.lastActivityFrameAt = at;
        this.frame({ type: "session.activity" });
        return;
      }
      case "answer":
      case "approval":
        return;
    }
  }

  send(data: string): void {
    let frame: { type?: unknown; content?: unknown };
    try {
      frame = JSON.parse(data) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === "session.close") {
      void this.stopSession().then(() => this.finishClose(NORMAL_CLOSE));
      return;
    }
    const session = this.session;
    if (!session || this.stopRequested || typeof frame.content !== "string") return;
    if (frame.type === "session.instructions.append" || frame.type === "session.thinking.append") session.appendText(frame.content);
    else if (frame.type === "session.commentary.append") session.appendSpeech(frame.content);
  }

  close(code: number = NORMAL_CLOSE): void {
    this.finishClose(code);
    void this.stopSession();
  }

  /** Closes the socket and resolves when the session has stopped. */
  async stop(): Promise<void> {
    this.finishClose(NORMAL_CLOSE);
    await this.stopSession();
  }

  private stopSession(): Promise<void> {
    this.stopRequested = true;
    if (this.session && !this.stopPromise) {
      this.stopPromise = this.session.stop().catch(() => undefined);
      this.onStop?.(this.stopPromise);
    }
    return this.stopPromise ?? Promise.resolve();
  }

  private finishClose(code: number): void {
    if (this.closeDelivered) return;
    this.closeDelivered = true;
    this.readyState = CLOSED;
    const handler = this.onclose;
    try {
      handler?.({ code });
    } catch {}
    this.onClosed?.();
  }

  private frame(body: Record<string, unknown>): void {
    const text = JSON.stringify(body);
    if (this.messageHandler) {
      this.messageHandler({ data: text });
      return;
    }
    if (this.held.length < MAX_HELD_FRAMES) this.held.push(text);
  }

  private flushHeld(): void {
    const frames = this.held.splice(0);
    for (const text of frames) this.messageHandler?.({ data: text });
  }

  private timing(role: "user" | "assistant"): { startMs: number; endMs: number } {
    const at = this.now();
    const nowMs = Math.max(0, at - this.createdAt);
    const previous = this.voices[role];
    const startMs = previous && at - previous.at <= UTTERANCE_GAP_MS ? previous.endMs : nowMs;
    const endMs = Math.max(startMs, nowMs);
    this.voices[role] = { endMs, at };
    return { startMs, endMs };
  }
}
