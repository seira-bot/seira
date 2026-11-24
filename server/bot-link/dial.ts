// A computer's end of the link (server/bot-link/link.ts): one exchange after another with its Cloud, each held open
// there until it has something to say, so both directions travel over requests this computer makes. It runs in the
// server, so the link holds with the app's window closed for as long as the computer is awake.
//
// A request that fails starts a new session after a wait that doubles up to a minute: each side then sends again whatever
// the other has not acknowledged. The Cloud's answer that it sleeps stops the asking until this computer has work for it
// or the app says the Cloud is awake (`start`), since any request would start a sleeping Cloud; the app looks every
// minute and never asks the Cloud itself to find out.
import { createWriteStream, mkdirSync, openAsBlob, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BotLink, EndedLink, FileTransfer } from "./link.ts";
import { FILE_PATH, HOLD_MS, LEVEL_HEADER, PROTOCOL_LEVEL, SYNC_PATH, TAKEN_HEADER, levelOf, syncAnswer, type FileWay, type Frame, type Numbered } from "./protocol.ts";

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** What the Cloud marks a held answer with while it goes to sleep. A Cloud that has not been updated sends only the old name. */
const POWER_HEADER = "x-seira-cloud-power";
const BACKGROUND_HEADER = "x-seira-background";
/** One file may take this long to cross; on a guest link its bytes may stop for no longer than FILE_IDLE_MS. */
const FILE_MS = 10 * 60_000;
export const FILE_IDLE_MS = 60_000;
const FAR_REFUSED = "the other side did not take or give the file";
const PROBE_MAX = 4_096;

/** The body of `response` as text, or null when it is longer than `max` bytes (`over`) or breaks off; and the bytes read. */
async function readUpTo(response: Response, max: number): Promise<{ text: string | null; bytes: number; over: boolean }> {
  if (!response.body) return { text: null, bytes: 0, over: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { await reader.cancel().catch(() => {}); return { text: null, bytes, over: true }; }
      chunks.push(value);
    }
  } catch { return { text: null, bytes, over: false }; }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, over: false };
}
/** The body of `response` as text, or null when it is longer than `max` bytes or breaks off. */
export const readCapped = async (response: Response, max: number): Promise<string | null> => (await readUpTo(response, max)).text;
const readJson = async (response: Response, max: number | undefined): Promise<unknown> => {
  if (max === undefined) return response.json();
  const text = await readCapped(response, max);
  if (text === null) throw new Error("the answer was too large or did not arrive whole");
  return JSON.parse(text);
};
export const isWorkFrame = (frame: Frame) => frame.t === "handoff" || frame.t === "result" || frame.t === "cancel";
const workIn = (frames: readonly Numbered[]) => frames.filter(({ frame }) => isWorkFrame(frame)).length;

/** How one side of a guest link paces what it sends the other. */
export interface SendPace {
  /** How many of `frames`, from the first, go now, and when some must wait, in how many milliseconds more may go. */
  next(frames: readonly Numbered[]): { count: number; waitMs: number };
  sent(frames: readonly Numbered[]): void;
  /** The other side took `taken` of the `work` work frames of the last batch. */
  took(work: number, taken: number): void;
}

/** A 503 that says the Cloud is going to sleep. The new name wins when both are present. */
export function cloudAsleepAnswer(response: Pick<Response, "status" | "headers">): boolean {
  const mark = response.headers.get(POWER_HEADER) ?? response.headers.get("x-omb-cloud-power");
  return response.status === 503 && mark === "asleep";
}

export interface DialerOptions {
  link: BotLink;
  fetch?: typeof fetch;
  log?(line: string): void;
  holdMs?: number;
  firstRetryMs?: number;
  /** What this computer says its version reads; a test stands in for an older app with it. */
  level?: number;
  /** The paths of the exchange and of the file crossing on the other side. */
  paths?: { sync: string; file: string };
  /** false: an error never carries the other side's own words, as for a server of another owner. */
  farText?: boolean;
  /** The frames of one answer this side takes: `count` of them from the first, and the ones to act on. The rest are
   * not acknowledged, so the other side sends them again. Absent: all of them. `undo` gives back what the choice spent,
   * when the frames could not be taken after all. */
  takes?(frames: readonly unknown[]): { count: number; frames: readonly unknown[]; undo?(): void };
  /** What is left of the other side's budget of work frames from this side, as this side counts what it took. */
  budget?: { left(): number; spend(frames: number): void };
  /** Room for a file this side gets, as for one the other side puts (server/routes/bot-link-exchange.ts). */
  room?(to: string, bytes: number): (() => void) | null;
  /** The largest answer read, in bytes. Absent: any. */
  answerMax?: number;
  /** A guest link's budget of answer bytes read in a window, with `answerMax`: an answer is read only up to what is left.
   * One that is longer is not taken, and the next exchange waits until a whole `answerMax` fits. */
  reads?: { left(): number; spend(bytes: number): void; waitFor(bytes: number): number };
  /** A guest link's pace for what this side sends. */
  sends?: SendPace;
  /** The least time from one answer that came at once to the next exchange, and between two new sessions. Absent: none. */
  pace?: { gapMs: number; freshMs: number };
  /** How long a file's bytes may stop before the file is given up. Absent: only the time limit of the whole file. */
  fileIdleMs?: number;
}

export function createDialer({ link, fetch: fetchImpl = fetch, log = () => {}, holdMs = HOLD_MS, firstRetryMs = FIRST_RETRY_MS, level = PROTOCOL_LEVEL, paths = { sync: SYNC_PATH, file: FILE_PATH }, farText = true,
  takes, budget, room, answerMax, reads, sends, pace, fileIdleMs }: DialerOptions) {
  let running = false, stopped = true, asleep = false, needsPairing = false;
  let lastStart = 0, lastEnd = 0, lastFresh = Number.NEGATIVE_INFINITY, roomAt = 0, paceWait = 0;
  let session = "", ack = 0, fresh = true, retryMs = firstRetryMs, slowMs = firstRetryMs, narrow = Number.POSITIVE_INFINITY;
  let held: AbortController | null = null;
  let wakeUp: (() => void) | null = null;
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wakeUp = null; resolve(); }, ms);
    timer.unref?.();
    wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve(); };
  });
  /** What waits to go, cut before the first work frame the other side's budget, or a batch it refused, has no room for,
   * or that the pace holds back. */
  const toSend = (peer: string): Numbered[] => {
    const all = link.outgoing(peer, 0);
    paceWait = 0;
    if (!budget) return all;
    let room = Math.min(budget.left(), narrow), end = 0;
    for (; end < all.length; end += 1) {
      if (!isWorkFrame(all[end]!.frame)) continue;
      if (room <= 0) break;
      room -= 1;
    }
    if (!sends) return all.slice(0, end);
    const next = sends.next(all.slice(0, end));
    paceWait = next.count < end ? next.waitMs : 0;
    return all.slice(0, next.count);
  };

  /** A file's bytes, over requests of this computer's: put before the frame that names it, got after one that does. An
   * answer in the 400s says the Cloud will not take or does not have it (`gone`); anything else is tried again. */
  const fileUrl = (origin: string, id: string, way: FileWay, index: number, name: string, more: Record<string, string> = {}) => `${origin}${paths.file}?${new URLSearchParams({ id, way, index: String(index), name, ...more })}`;
  const refusedFile = async (response: Response) => {
    const gone = response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status);
    if (!farText) { await response.body?.cancel().catch(() => {}); return Object.assign(new Error(FAR_REFUSED), { gone }); }
    const told = await response.json().then((answer) => { const error = (answer as { error?: unknown } | null)?.error; return typeof error === "string" ? error : ""; }, () => "");
    return Object.assign(new Error(told || `the Cloud answered ${response.status}`), { gone });
  };
  const cloud = () => { const target = link.dial(); if (!target) throw new Error("not linked"); return { ...target, headers: { authorization: `Bearer ${target.token}`, origin: target.origin } }; };
  const transfer: FileTransfer = {
    async holds(id, way, index, file) {
      const target = cloud();
      const response = await fetchImpl(fileUrl(target.origin, id, way, index, file.name, { probe: "1", bytes: String(file.bytes) }), { redirect: "error", signal: AbortSignal.timeout(30_000), headers: target.headers });
      if (!response.ok) throw await refusedFile(response);
      return (await readJson(response, answerMax === undefined ? undefined : PROBE_MAX) as { have?: unknown } | null)?.have === true;
    },
    async push(id, way, index, file) {
      const target = cloud();
      const response = await fetchImpl(fileUrl(target.origin, id, way, index, file.name), { method: "PUT", redirect: "error", signal: AbortSignal.timeout(FILE_MS),
        headers: { ...target.headers, "content-type": "application/octet-stream" }, body: await openAsBlob(file.path) });
      if (!response.ok) throw await refusedFile(response);
      await response.body?.cancel();
    },
    async pull(id, way, index, meta, to) {
      const target = cloud();
      const release = room ? room(to, meta.bytes) : () => {};
      if (!release) throw new Error("there is no room for it here now");
      const idle = new AbortController(), signal = AbortSignal.any([AbortSignal.timeout(FILE_MS), idle.signal]);
      let quiet: NodeJS.Timeout | undefined;
      const stir = () => { if (fileIdleMs === undefined) return; clearTimeout(quiet); quiet = setTimeout(() => idle.abort(new Error("the file stopped coming")), fileIdleMs); quiet.unref?.(); };
      try {
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        stir();
        const response = await fetchImpl(fileUrl(target.origin, id, way, index, meta.name), { redirect: "error", signal, headers: target.headers });
        if (!response.ok || !response.body) throw await refusedFile(response);
        // No more than the frame said: a file that turns out larger is not kept.
        let taken = 0, over = false;
        const capped = new Transform({ transform(chunk: Buffer, _encoding, done) { stir(); taken += chunk.length; over = taken > meta.bytes; done(over ? new Error("too large") : null, chunk); } });
        try {
          await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), capped, createWriteStream(to, { mode: 0o600 }), { signal });
        } catch (error) {
          rmSync(to, { force: true });
          throw over ? Object.assign(new Error(`${meta.name} is larger than it was said to be`), { gone: true }) : error;
        }
        if (taken !== meta.bytes) { rmSync(to, { force: true }); throw new Error(`${meta.name} did not arrive whole`); }
      } finally { clearTimeout(quiet); release(); }
    },
  };
  link.setTransfer(transfer);
  const stopListening = link.onOutgoing(() => { held?.abort(); });
  const stopWanted = link.onWanted(() => { if (stopped) return; asleep = false; retryMs = firstRetryMs; wakeUp?.(); });

  /** How many frames of `sending` the other side took, as its answer says. */
  function sent(peer: string, sending: readonly Numbered[], response: Response): number {
    const said = Number(response.headers.get(TAKEN_HEADER) ?? Number.NaN);
    const taken = Number.isSafeInteger(said) && said >= 0 ? Math.min(said, sending.length) : budget ? 0 : sending.length;
    link.outgoing(peer, sending[taken - 1]?.seq ?? 0);
    budget?.spend(workIn(sending.slice(0, taken)));
    sends?.sent(sending);
    sends?.took(workIn(sending), workIn(sending.slice(0, taken)));
    if (taken === sending.length) narrow *= 2;
    return taken;
  }

  /** The answer's body, read up to what `reads` has left. Undefined when it is longer than that: then nothing of it is
   * taken, and the next exchange waits for room. */
  async function answerOf(response: Response): Promise<unknown> {
    if (answerMax === undefined) return response.json();
    const room = reads ? Math.min(answerMax, reads.left()) : answerMax;
    const read = await readUpTo(response, room);
    reads?.spend(Math.min(read.bytes, room));
    if (read.over && reads && room < answerMax) { roomAt = Date.now() + reads.waitFor(answerMax); return undefined; }
    if (read.text === null) throw new Error("the answer was too large or did not arrive whole");
    return JSON.parse(read.text);
  }

  /** One exchange. True when the other side answered 429, or without `sends`, when the other side took less than was
   * sent or this side took less than it was sent: the next exchange waits, so a spent budget is not asked again at once.
   * With `sends`, its pause does that. */
  async function exchange(target: { origin: string; token: string }, peer: string): Promise<boolean> {
    if (fresh) { lastFresh = Date.now(); link.sessionStarted(peer); }
    const sending = toSend(peer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), holdMs + 15_000);
    timeout.unref?.();
    const wait = sending.length > 0 || fresh ? 0 : paceWait > 0 ? Math.min(holdMs, Math.ceil(paceWait)) : holdMs;
    if (wait > 0) held = controller;
    let response: Response;
    try {
      response = await fetchImpl(`${target.origin}${paths.sync}`, {
        method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${target.token}`, origin: target.origin, [LEVEL_HEADER]: String(level),
          ...(workIn(sending) > 0 ? {} : { [BACKGROUND_HEADER]: "1" }) },
        body: JSON.stringify({ fresh, ack, frames: sending.map((entry) => entry.frame), wait }),
      });
    } catch (error) {
      if (held === controller && controller.signal.aborted && !stopped && !asleep && link.hasOutgoing(peer)) return false;
      throw error;
    } finally {
      clearTimeout(timeout);
      if (held === controller) held = null;
    }
    if (cloudAsleepAnswer(response)) {
      await response.body?.cancel();
      asleep = true; fresh = true;
      link.setSleeps(true);
      link.setOnline(peer, false);
      return false;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      needsPairing = true;
      link.setOnline(peer, false);
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 && budget) { link.setOnline(peer, false); if (workIn(sending) > 0) narrow = Math.max(1, Math.floor(Math.min(narrow, workIn(sending)) / 2)); return true; }
      throw new Error(`the Cloud answered ${response.status}`);
    }
    const body = await answerOf(response);
    if (body === undefined) { sent(peer, sending, response); return false; }
    const answer = syncAnswer.safeParse(body);
    if (!answer.success) throw new Error("the Cloud's answer did not parse");
    const taken = sent(peer, sending, response);
    if (answer.data.session !== session) {
      const restarted = session !== "";
      session = answer.data.session; ack = 0;
      if (restarted && !fresh) { fresh = true; return false; }
    }
    fresh = false; retryMs = firstRetryMs;
    link.setOnline(peer, true);
    link.setLevel(peer, levelOf(response.headers.get(LEVEL_HEADER)));
    const news = answer.data.frames.filter((entry) => entry.seq > ack);
    const intake: ReturnType<NonNullable<DialerOptions["takes"]>> = takes ? takes(news.map((entry) => entry.frame)) : { count: news.length, frames: news.map((entry) => entry.frame) };
    const count = Math.min(intake.count, news.length);
    try { link.receive(peer, intake.frames); } catch (error) { intake.undo?.(); throw error; }
    ack = Math.max(ack, ...news.slice(0, count).map((entry) => entry.seq));
    return !sends && (taken < sending.length || count < news.length);
  }

  async function loop(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (!stopped) {
        const target = link.dial(), peer = link.cloudPeer();
        if (!target || !peer || needsPairing) break;
        if (asleep) { await pause(24 * 60 * 60_000); continue; }
        const due = Math.max(pace ? Math.max(fresh ? lastFresh + pace.freshMs : 0, lastEnd - lastStart < pace.gapMs ? lastEnd + pace.gapMs : 0) : 0, roomAt) - Date.now();
        if (due > 0) { await pause(due); continue; }
        try {
          lastStart = Date.now();
          const slow = await exchange(target, peer).finally(() => { lastEnd = Date.now(); });
          if (!slow) { slowMs = firstRetryMs; continue; }
          await pause(slowMs * (0.75 + Math.random() / 2));
          slowMs = Math.min(slowMs * 2, holdMs);
        } catch (error) {
          if (stopped) break;
          link.setOnline(peer, false);
          fresh = true;
          if (!asleep) log(`bot link: the Cloud could not be reached (${error instanceof Error ? error.message : String(error)}); trying again in ${Math.round(retryMs / 1000)} s`);
          await pause(retryMs * (0.75 + Math.random() / 2));
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        }
      }
    } finally { running = false; }
  }

  /** One request that says the link is over. True when the Cloud took it, or no longer knows the link. */
  async function bye(ended: Pick<EndedLink, "origin" | "token">): Promise<boolean> {
    try {
      const response = await fetchImpl(`${ended.origin}${paths.sync}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${ended.token}`, origin: ended.origin, [BACKGROUND_HEADER]: "1" },
        body: JSON.stringify({ ack: 0, frames: [{ t: "bye" } satisfies Frame], wait: 0 }) });
      await response.body?.cancel();
      return response.ok || response.status === 401 || response.status === 403;
    } catch { return false; }
  }

  return {
    /** Starts asking, or asks again at once: after turning on, after pairing again, or when the app says the Cloud is
     * awake. `gentle`: this server just started, so a Cloud that sleeps is left alone until the app says it is awake or
     * there is work for it. */
    start({ gentle = false }: { gentle?: boolean } = {}): void {
      stopped = false; asleep = gentle && link.sleeps(); needsPairing = false; fresh = true; retryMs = firstRetryMs;
      wakeUp?.();
      void loop();
    },
    /** The app says the Cloud sleeps now: nothing asks it until there is work for it or it is awake again. */
    sleep(): void { if (!stopped) { link.setSleeps(true); asleep = true; fresh = true; const peer = link.cloudPeer(); if (peer) link.setOnline(peer, false); held?.abort(); } },
    /** Stops asking. `bye`: the link was turned off here, so the Cloud is told once, unless it sleeps. True when it knows. */
    async stop({ bye: tell = false }: { bye?: boolean } = {}): Promise<boolean> {
      const target = link.dial(), sleeping = asleep;
      stopped = true;
      held?.abort();
      wakeUp?.();
      return tell && target !== null && !sleeping ? bye(target) : false;
    },
    /** The app says this Cloud is awake: links to it that ended while it could not be told are ended there now. */
    async tellEnded(origin: string): Promise<void> {
      const told: string[] = [];
      for (const ended of link.ended()) if (ended.origin === origin && await bye(ended)) told.push(ended.token);
      if (told.length) link.forgetEnded(told);
    },
    state: () => ({ running: !stopped, asleep, needsPairing }),
    close(): void { stopped = true; held?.abort(); wakeUp?.(); stopListening(); stopWanted(); link.setTransfer(null); },
  };
}
