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

/** True only for an error that a server module made for the client: a `PublicError` or a subclass. Its message was written
 * for the person who reads it. Any other error is internal: a library, the file system or a remote service worded it, so
 * its text can name a path, an address or a secret. An HTTP status or an `errorKey` on an error does not make it public. */
export function isPublicError(error: unknown): error is PublicError {
  return error instanceof PublicError;
}

function logInternal(error: unknown, where: string): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[http] ${where} failed: ${redactSecretsInText(detail)}`);
}

/** The text of an HTTP error reply. A `PublicError` keeps its own message. Any other error gives `fallback`, and its full
 * text goes only to the server log, with secrets removed. `where` names the request in that log line. */
export function publicErrorText(error: unknown, where: string, fallback: string = GENERIC_PUBLIC_ERROR): string {
  if (isPublicError(error)) return error.message;
  logInternal(error, where);
  return fallback;
}

/** TRANSITIONAL. For a reply whose error comes from many server modules that raise a refusal as a plain `Error` with a 4xx
 * `status`. Such an error keeps its message. Any other error, and any error with a 5xx status, gives the fallback. Move
 * each module to `PublicError`, then use `publicErrorText` here. */
export function refusalErrorText(error: unknown, where: string, fallback: string = GENERIC_PUBLIC_ERROR): string {
  if (isPublicError(error)) return error.message;
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof Error && typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) return error.message;
  logInternal(error, where);
  return fallback;
}
