// The transport of one A2A peer's guest link, in place of the exchange of a linked server: each frame the link sends to
// the peer goes to the side that acts on it. A result answers the peer's task, a hand-off and a cancel go out to it.
import type { BotLink } from "../bot-link/link.ts";
import type { Frame, HandoffFrame, ResultFrame } from "../bot-link/protocol.ts";

export interface A2aTransportDeps {
  link: Pick<BotLink, "has" | "onOutgoing" | "outgoing" | "setOnline" | "sessionStarted">;
  /** The peer's key on its guest link. */
  key: string;
  inbound: { settled(id: string, frame: ResultFrame): void; close(): void };
  outbound: { send(frame: HandoffFrame): void; cancel(id: string): void; close(): void };
  log?: (line: string) => void;
}

export interface A2aTransport {
  /** The peer is online on its link, and the link sends again what the peer has not taken. Safe to call again. */
  start(): void;
  /** The peer is offline on its link, and its inbound and outbound sides end. */
  close(): void;
}

export function createA2aTransport(deps: A2aTransportDeps): A2aTransport {
  const log = deps.log ?? (() => {});
  let ack = 0;
  let queued = false;
  let closed = false;
  let unsubscribe: (() => void) | null = null;

  function route(frame: Frame): void {
    if (frame.t === "result") deps.inbound.settled(frame.id, frame);
    else if (frame.t === "handoff") deps.outbound.send(frame);
    else if (frame.t === "cancel") deps.outbound.cancel(frame.id);
  }

  function drain(): void {
    queued = false;
    if (closed || !unsubscribe) return;
    if (!deps.link.has(deps.key)) { ack = 0; return; }
    for (let batch = deps.link.outgoing(deps.key, ack); batch.length > 0 && !closed; batch = deps.link.outgoing(deps.key, ack)) {
      for (const entry of batch) {
        ack = entry.seq;
        try { route(entry.frame); } catch (error) { log(`a2a: a ${entry.frame.t} frame for the peer failed (${String(error)})`); }
        if (closed) return;
      }
    }
  }

  const wake = (peer: string) => {
    if (peer !== deps.key || queued || closed) return;
    queued = true;
    queueMicrotask(drain);
  };

  return {
    start() {
      if (closed) return;
      unsubscribe ??= deps.link.onOutgoing(wake);
      ack = 0;
      deps.link.setOnline(deps.key, true);
      deps.link.sessionStarted(deps.key);
      drain();
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      deps.link.setOnline(deps.key, false);
      deps.inbound.close();
      deps.outbound.close();
    },
  };
}
