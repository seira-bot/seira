// The chips a bot offered during a turn, held until that turn ends. The bot offers them through the suggest_replies
// tool, in the turn it is already running: no helper model call, no text read back out of the reply. A turn that does not
// finish well drops them. Only the turn's last text line carries them, and only after the shared cleaner kept them.
import { cleanSuggestedReplies, type SuggestedReply } from "../packages/phone-protocol/src/suggested-replies.ts";
import { redactSecretsInText } from "./redact.ts";

export class PendingSuggestedReplies {
  readonly #byThread = new Map<string, SuggestedReply[]>();

  /** Keeps the cleaned list for the thread's running turn, replacing an earlier one. An entry that holds a secret is dropped
   * whole: redaction must never change what a tap would send. Returns how many entries were kept. */
  offer(threadId: string, raw: unknown): number {
    const cleaned = (cleanSuggestedReplies(raw) ?? []).filter((reply) => redactSecretsInText(reply.title) === reply.title && redactSecretsInText(reply.prompt) === reply.prompt);
    if (cleaned.length === 0) {
      this.#byThread.delete(threadId);
      return 0;
    }
    this.#byThread.set(threadId, cleaned);
    return cleaned.length;
  }

  /** The list for the turn that just ended, and forgets it. */
  take(threadId: string): SuggestedReply[] | undefined {
    const held = this.#byThread.get(threadId);
    this.#byThread.delete(threadId);
    return held;
  }

  /** A turn starts: nothing offered before it counts. */
  clear(threadId: string): void {
    this.#byThread.delete(threadId);
  }
}
