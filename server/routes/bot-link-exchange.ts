// The standing exchange and the file crossing of a link, for one authenticated peer: the long poll that carries frames both
// ways, and the file probe, get and put. The caller has already checked who the peer is; this module owns the rest.
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BotLink } from "../bot-link/link.ts";
import { LEVEL_HEADER, PROTOCOL_LEVEL, SEEN_MS, TAKEN_HEADER, fileWay, levelOf, syncRequest } from "../bot-link/protocol.ts";
import { FILE_MAX_BYTES } from "../../shared/upload-limits.ts";
import { answerAsleep } from "../cloud-power.ts";
import type { RouteContext } from "./table.ts";

export interface LinkExchangeOptions {
  link: BotLink;
  paths: { sync: string; file: string };
  power(): { sleeping(): boolean; sleepSignal(): AbortSignal } | null | undefined;
  seenMs?: number;
  /** What this place says its version reads; a test stands in for an older Cloud with it. */
  level?: number;
  /** A guest link's room for a file that is about to arrive at `to` with `bytes`: a release for when its write ends, or
   * null when it may not come now. Absent: a file needs no room but its own size limit. With it, a file must say its size. */
  room?(to: string, bytes: number): (() => void) | null;
  /** A guest link's choice of the frames of one exchange to take: `count` of them, from the first, are taken and the
   * peer sends the rest again; `frames` are the ones to act on. The answer says `count` in TAKEN_HEADER. `undo` gives
   * back what the choice spent, when the frames could not be taken after all. */
  takes?(frames: readonly unknown[], ack: number): { count: number; frames: readonly unknown[]; undo?(): void };
  /** A guest link's limits on its peer's exchanges and on the new sessions among them: false answers 429. */
  pace?: { exchange(): boolean; session(): boolean };
  /** A guest link's own form of a file name its peer gives, the same as the one its frames get. */
  fileName?(name: string): string;
  log?(line: string): void;
}

/** An error of reading the request body keeps its own status and text; it holds nothing about this server. */
class BodyRefused { error: unknown; constructor(error: unknown) { this.error = error; } }

export function createLinkExchange({ link, paths, power: powerOf, seenMs, level, room, takes, pace, fileName: ownName = (name) => name, log = (line) => console.error(line) }: LinkExchangeOptions) {
  const session = randomUUID();
  const held = new Map<string, () => void>();
  const gone = new Map<string, NodeJS.Timeout>();
  const seen = (peer: string) => {
    link.setOnline(peer, true);
    clearTimeout(gone.get(peer));
    const timer = setTimeout(() => { gone.delete(peer); link.setOnline(peer, false); }, seenMs ?? SEEN_MS);
    timer.unref?.();
    gone.set(peer, timer);
  };
  /** Until the link has something to send, the wait ends, the computer hangs up or asks again, or the Cloud goes to sleep. */
  const hold = (res: ServerResponse, peer: string, ack: number, wait: number, sleep: AbortSignal | undefined) => new Promise<void>((resolve) => {
    held.get(peer)?.();
    const done = () => { clearTimeout(timer); stop(); res.off("close", done); sleep?.removeEventListener("abort", done); if (held.get(peer) === done) held.delete(peer); resolve(); };
    const timer = setTimeout(done, wait);
    const stop = link.onOutgoing((changed) => { if (changed === peer && (!link.has(peer) || link.hasOutgoing(peer, ack))) done(); });
    res.on("close", done);
    sleep?.addEventListener("abort", done, { once: true });
    held.set(peer, done);
  });

  /** Every error that the exchange does not answer itself gets one fixed answer, so a cause (a path in the data folder) never reaches the peer. */
  function unavailable({ res, json }: RouteContext, what: string, text: string, error: unknown): void {
    log(`bot link: ${what} (${error instanceof Error ? error.message : String(error)})`);
    if (res.headersSent || res.destroyed) res.destroy(); else json(res, 503, { error: text });
  }

  async function file(ctx: RouteContext, peer: string): Promise<void> {
    try { await fileOf(ctx, peer); } catch (error) { unavailable(ctx, "a file request could not be served", "the file could not be handled now; try again later", error); }
  }

  async function fileOf({ req, res, url, method, json }: RouteContext, peer: string): Promise<void> {
    const id = url.searchParams.get("id") ?? "", way = fileWay.safeParse(url.searchParams.get("way")), index = Number(url.searchParams.get("index")), fileName = ownName(url.searchParams.get("name") ?? "");
    if (!id || id.length > 200 || !way.success || !Number.isInteger(index) || !fileName || fileName.length > 255) { req.resume(); return json(res, 400, { error: "send id, way, index and name" }); }
    if (powerOf()?.sleeping()) { req.resume(); return answerAsleep(res, json); }
    seen(peer);
    if (method === "GET" && url.searchParams.has("probe")) return json(res, 200, { have: link.holds(peer, id, way.data, index, fileName, Number(url.searchParams.get("bytes"))) });
    if (method === "GET") {
      const kept = link.outgoingFile(peer, id, way.data, index);
      let bytes = -1;
      try { if (kept) bytes = statSync(kept.path).size; } catch { /* no longer kept */ }
      if (!kept || bytes < 0) return json(res, 404, { error: "that file is no longer kept" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes) });
      await pipeline(createReadStream(kept.path), res).catch(() => {});
      return;
    }
    if (method !== "PUT") { req.resume(); return json(res, 405, { error: "method not allowed" }); }
    const to = link.incoming(peer, id, way.data, index, fileName);
    if (!to) { req.resume(); return json(res, 409, { error: "that file is not wanted here any more" }); }
    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    if (room && !(Number.isSafeInteger(declared) && declared >= 0)) { req.resume(); return json(res, 411, { error: "say the size of the file" }); }
    if (room && declared > FILE_MAX_BYTES) { req.resume(); return json(res, 413, { error: `a file may be at most ${Math.round(FILE_MAX_BYTES / (1024 * 1024))} MB` }); }
    const release = room ? room(to, declared) : () => {};
    if (!release) { req.resume(); return json(res, 429, { error: "there is no room for that file here now; try again later" }); }
    const limit = room ? declared : FILE_MAX_BYTES;
    let taken = 0;
    const capped = new Transform({ transform(chunk: Buffer, _encoding, done) { taken += chunk.length; done(taken > limit ? new Error("too large") : null, chunk); } });
    try {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      await pipeline(req, capped, createWriteStream(to, { mode: 0o600 }));
    } catch {
      rmSync(to, { force: true });
      if (res.destroyed) return;
      return json(res, taken > limit ? 413 : 400, { error: taken > limit ? `a file may be at most ${Math.round(FILE_MAX_BYTES / (1024 * 1024))} MB` : "the file did not arrive whole" });
    } finally {
      release();
    }
    return json(res, 200, { ok: true });
  }

  async function sync(ctx: RouteContext, peer: string, stillLinked: () => boolean): Promise<void> {
    try { await syncOf(ctx, peer, stillLinked); } catch (error) {
      if (error instanceof BodyRefused) throw error.error;
      unavailable(ctx, "an exchange could not be served", "the frames could not be taken now; try again later", error);
    }
  }

  async function syncOf({ req, res, method, json, readBody }: RouteContext, peer: string, stillLinked: () => boolean): Promise<void> {
    if (method !== "POST") { req.resume(); return json(res, 405, { error: "method not allowed" }); }
    if (pace && !pace.exchange()) { req.resume(); return json(res, 429, { error: "too many requests; try again later" }); }
    const body = syncRequest.safeParse(await readBody(req, 4 * 1024 * 1024).catch((error: unknown) => { throw new BodyRefused(error); }));
    if (!body.success) return json(res, 400, { error: "send { ack, frames, wait }" });
    if (body.data.fresh && pace && !pace.session()) return json(res, 429, { error: "too many new sessions; try again later" });
    const power = powerOf();
    if (power?.sleeping()) return answerAsleep(res, json);
    seen(peer);
    // Each side says what its version reads; a computer on the first version says nothing and is sent only what that reads.
    link.setLevel(peer, levelOf(req.headers[LEVEL_HEADER]));
    if ((level ?? PROTOCOL_LEVEL) > 1) res.setHeader(LEVEL_HEADER, String(level ?? PROTOCOL_LEVEL));
    if (body.data.fresh) link.sessionStarted(peer);
    const taken = takes?.(body.data.frames, body.data.ack);
    if (taken) res.setHeader(TAKEN_HEADER, String(taken.count));
    try {
      link.receive(peer, taken ? taken.frames : body.data.frames);
    } catch (error) {
      taken?.undo?.();
      res.removeHeader(TAKEN_HEADER);
      log(`bot link: the frames of an exchange could not be taken (${error instanceof Error ? error.message : String(error)})`);
      return json(res, 503, { error: "the frames could not be taken now; try again later" });
    }
    if (!stillLinked()) { clearTimeout(gone.get(peer)); gone.delete(peer); return json(res, 200, { session, frames: [] }); }
    if (body.data.wait > 0 && !link.hasOutgoing(peer, body.data.ack)) await hold(res, peer, body.data.ack, body.data.wait, power?.sleepSignal());
    if (power?.sleeping()) return answerAsleep(res, json);
    if (res.writableEnded || res.destroyed) return;
    if (!stillLinked()) return json(res, 403, { error: "This link is off. Turn it on again in the app." });
    seen(peer);
    return json(res, 200, { session, frames: link.outgoing(peer, body.data.ack) });
  }

  return {
    /** Answers a request on one of `paths`, from a peer the caller has already identified. `stillLinked` says whether that peer's link is still the one in use. */
    serve(ctx: RouteContext, peer: string, stillLinked: () => boolean): Promise<void> {
      return ctx.path === paths.file ? file(ctx, peer) : sync(ctx, peer, stillLinked);
    },
    /** Ends the peer's held wait, so its next request starts at once. */
    release(peer: string): void { held.get(peer)?.(); },
  };
}
