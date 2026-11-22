/** The message of an Error, or `fallback` for any other thrown value. Never the stack and never `String(value)`. */
export function publicErrorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
