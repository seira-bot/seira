import { redactSecretsInText } from "./redact.ts";

/** The message of an Error, or `fallback` for any other thrown value. Never the stack and never `String(value)`. */
export function publicErrorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The words a client gets for an error that nobody wrote for it. */
export const GENERIC_PUBLIC_ERROR = "The server could not finish this request. Try again. If it keeps failing, ask the server's admin to read the server log.";

/** An error whose message was written for the person who sees it. Its text may go to an HTTP client as it is. */
export class PublicError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

/** A `PublicError` that carries no HTTP status, as an error thrown with no status did before. The reply then takes the
 * status that the place sending it chooses. */
export function unstatused<T extends PublicError>(error: T): T {
  delete (error as { status?: number }).status;
  return error;
}

/** A class that sets this key to `true` makes errors whose message was written for the client, with its own status.
 * Use it on a refusal class when its constructor does not take the status in the same way as `PublicError`. */
export const PUBLIC_ERROR_MARK = Symbol("seira.publicError");

/** True only for an error that a server module made for the client: a `PublicError`, or an error of a class that sets
 * `PUBLIC_ERROR_MARK`. Its message was written for the person who reads it. Any other error is internal: a library, the
 * file system or a remote service worded it, so its text can name a path, an address or a secret. An HTTP status, a code
 * or an `errorKey` on an error does not make it public. An explicit `withheld` decision always wins over the type. */
export function isPublicError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const mark = (error as { [PUBLIC_ERROR_MARK]?: unknown })[PUBLIC_ERROR_MARK];
  if (mark === false) return false;
  return error instanceof PublicError || mark === true;
}

/** Take back the public status of one error whose message holds text from outside (a remote service or a library). This
 * holds for a `PublicError` and for a marked class too. */
export function withheld<T extends Error>(error: T): T {
  Object.defineProperty(error, PUBLIC_ERROR_MARK, { value: false, configurable: true });
  return error;
}

/** Give `wrapped` the decision that `source` has: a wrapper of an error that is not public is not public. */
export function inheritingPublicDecision<T extends Error>(source: unknown, wrapped: T): T {
  return isPublicError(source) ? wrapped : withheld(wrapped);
}

function logInternal(error: unknown, where: string): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[http] ${where} failed: ${redactSecretsInText(detail)}`);
}

/** The text of an HTTP error reply. A public error keeps its own message. Any other error gives `fallback`, and its full
 * text goes only to the server log, with secrets removed. `where` names the request in that log line. The status and the
 * code of the reply are a separate decision of the caller. */
export function publicErrorText(error: unknown, where: string, fallback: string = GENERIC_PUBLIC_ERROR): string {
  if (isPublicError(error)) return error.message;
  logInternal(error, where);
  return fallback;
}
