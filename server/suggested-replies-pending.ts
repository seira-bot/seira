// The chips a bot offered during a turn, held until that turn ends. The bot offers them through the suggest_replies
// tool, in the turn it is already running: no helper model call, no text read back out of the reply. A turn that does not
// finish well drops them. Only the turn's last text line carries them, and only after the shared cleaner kept them.
import { cleanSuggestedReplies, type SuggestedReply } from "../packages/phone-protocol/src/suggested-replies.ts";
import { redactSecretsInText } from "./redact.ts";

/** The request record a turn runs under (the server's own record, never model text). */
export interface SuggestionRequest {
  generation: string;
  generations: ReadonlySet<string>;
  stopped?: boolean;
  kind?: string;
  /** Never proof: the host sets it for a line typed in a chat, but only `origin` says who wrote the request. */
  personLine?: true;
  /** The host's own origin for the request (`requestWorkOrigin`). Absent or not `user` means a person did not write it. */
  origin?: { kind: string };
}

/** True only for a turn that a person's own message started in this chat, not stopped, and that this generation belongs to.
 * The request origin must be `user`: `personLine` never replaces it. A routine, webhook, API call, hand-off, continuation
 * or guest turn is never one. */
export function personStartedTurn(request: SuggestionRequest | undefined, generation: string | undefined): boolean {
  if (!request || generation === undefined || request.stopped || request.kind !== "person") return false;
  if (request.origin?.kind !== "user") return false;
  return request.generations.has(generation);
}

export class PendingSuggestedReplies {
  readonly #byThread = new Map<string, { generation: string; replies: SuggestedReply[] }>();

  /** Keeps the cleaned list for one turn generation of the thread, replacing an earlier one. Nothing is kept unless the
   * request proves a person started that turn. An entry that holds a secret is dropped whole: redaction must never change
   * what a tap would send. Returns how many entries were kept. */
  offer(threadId: string, generation: string, request: SuggestionRequest | undefined, raw: unknown): number {
    if (!personStartedTurn(request, generation)) {
      this.#byThread.delete(threadId);
      return 0;
    }
    const cleaned = (cleanSuggestedReplies(raw) ?? []).filter((reply) => redactSecretsInText(reply.title) === reply.title && redactSecretsInText(reply.prompt) === reply.prompt);
    if (cleaned.length === 0) {
      this.#byThread.delete(threadId);
      return 0;
    }
    this.#byThread.set(threadId, { generation, replies: cleaned });
    return cleaned.length;
  }

  /** The list for the turn that just ended, and forgets it. A list that another generation offered, or that the request
   * no longer proves, is dropped. */
  take(threadId: string, generation: string | undefined, request: SuggestionRequest | undefined): SuggestedReply[] | undefined {
    const held = this.#byThread.get(threadId);
    this.#byThread.delete(threadId);
    return held && held.generation === generation && personStartedTurn(request, generation) ? held.replies : undefined;
  }

  /** A turn starts: nothing offered before it counts. */
  clear(threadId: string): void {
    this.#byThread.delete(threadId);
  }
}
