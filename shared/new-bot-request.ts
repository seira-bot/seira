/** A retry key for one creation, in the form the server accepts (letters, digits, - and _, 16 to 128). */
export function newRetryKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `retry-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The waits before sending a creation again after no answer came. */
export const RESEND_AFTER_MS: readonly number[] = [1_000, 3_000];

/** No answer came, so the server may have made the bot: a network failure or a client-side timeout. */
function gotNoAnswer(error: unknown): boolean {
  return error instanceof TypeError || (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** Makes one bot. The request carries a retry key of its own. The server makes the bot's id and remembers, for the one
 * who sent the key, which bot the key made, so sending the same request again after a lost answer gets that bot and
 * cannot make a second one. The key means nothing to anyone else: another sender with the same key gets a bot of their own. */
export async function createBotOnce<T>(
  body: object,
  send: (body: Record<string, unknown>) => Promise<T>,
  resendAfter: readonly number[] = RESEND_AFTER_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((done) => setTimeout(done, ms)),
): Promise<T> {
  const request = { ...body, retryKey: newRetryKey() };
  for (let resent = 0; ; resent += 1) {
    try {
      return await send(request);
    } catch (error) {
      if (!gotNoAnswer(error) || resent >= resendAfter.length) throw error;
      await sleep(resendAfter[resent]!);
    }
  }
}

/** `createBotOnce` over one request function: `POST /api/bots`. */
export function createBotThrough<T>(body: object, call: (path: string, init?: RequestInit) => Promise<T>): Promise<T> {
  return createBotOnce<T>(body, (sent) => call("/api/bots", { method: "POST", body: JSON.stringify(sent) }));
}
