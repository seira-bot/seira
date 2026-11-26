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

/** True when the error was made for the client: a `PublicError`, an error with a language-pack key (`userErrorThrown`),
 * or an `Error` that carries a 4xx `status` (the refusal classes of the server set one on purpose). Any other error is
 * internal: a library, the file system or a remote service worded it, so its text can name a path, an address or a
 * secret. An error with a 5xx status is internal too. */
export function isPublicError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error instanceof PublicError) return true;
  const { status, errorKey } = error as { status?: unknown; errorKey?: unknown };
  if (typeof errorKey === "string" && errorKey.startsWith("serverError.")) return true;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500;
}

/** The text of an HTTP error reply. A public error keeps its own message. Any other error gives `fallback`, and its full
 * text goes only to the server log, with secrets removed. `where` names the request in that log line. */
export function publicErrorText(error: unknown, where: string, fallback: string = GENERIC_PUBLIC_ERROR): string {
  if (isPublicError(error)) return error.message;
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[http] ${where} failed: ${redactSecretsInText(detail)}`);
  return fallback;
}
