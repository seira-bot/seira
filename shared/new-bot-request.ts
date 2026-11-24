/** A bot id for one creation, in the form the server keeps (letters, digits, - and _, 8 to 128). */
export function newBotId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `bot-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The waits before sending a creation again after no answer came. */
export const RESEND_AFTER_MS: readonly number[] = [1_000, 3_000];

export interface CreateBotIo<T> {
  send(body: Record<string, unknown>): Promise<T>;
  /** The bot with this id, or null when there is none. */
  find(id: string): Promise<T | null>;
  sleep?(ms: number): Promise<void>;
}

/** No answer came, so the server may have made the bot: a network failure or a client-side timeout. */
function gotNoAnswer(error: unknown): boolean {
  return error instanceof TypeError || (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** Makes one bot. The request carries an id of the client's own: the server answers 409 for an id it already has, so
 * sending the same request again after a lost answer cannot make a second bot. `fresh` tells the server the bot is new,
 * not one moved in from another computer, so it still gets its greeting and its own look. A 409 on a resend means the
 * first request made the bot: that bot is the result. */
export async function createBotOnce<T>(body: object, io: CreateBotIo<T>, resendAfter: readonly number[] = RESEND_AFTER_MS): Promise<T> {
  const named = (body as { id?: unknown }).id;
  const request = { ...body, id: typeof named === "string" ? named : newBotId(), fresh: true };
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let resent = 0; ; resent += 1) {
    try {
      return await io.send(request);
    } catch (error) {
      if (gotNoAnswer(error) && resent < resendAfter.length) {
        await sleep(resendAfter[resent]!);
        continue;
      }
      if (resent > 0 && (error as { status?: unknown } | null)?.status === 409) {
        const made = await io.find(request.id);
        if (made) return made;
      }
      throw error;
    }
  }
}

/** `createBotOnce` over one request function: `POST /api/bots`, and `GET /api/bots/<id>` to find a bot that is already there. */
export function createBotThrough<T extends { bot?: unknown }>(body: object, call: (path: string, init?: RequestInit) => Promise<T>): Promise<T> {
  return createBotOnce<T>(body, {
    send: (sent) => call("/api/bots", { method: "POST", body: JSON.stringify(sent) }),
    find: (id) => call(`/api/bots/${encodeURIComponent(id)}`).then((found) => (found?.bot ? found : null), () => null),
  });
}
