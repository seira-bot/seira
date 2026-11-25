import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { BOTS_FILE } from "./registry-store.ts";

/** bots.json is there, and it does not read as a list of bots. */
export class UnreadableBotsError extends Error {}

/** Keeps the bytes of the file under a name of their own, once for each content. A file that cannot be read has no copy. */
export function keepUnreadableBots(file = BOTS_FILE): string | undefined {
  let copy: string | undefined;
  try {
    const bytes = readFileSync(file);
    copy = `${file}.damaged-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
    writeFileSync(copy, bytes, { flag: "wx", mode: 0o600 });
    return copy;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? copy : undefined;
  }
}

/** The message names the error code only: the text of a parse error quotes the file. */
export function refuseUnreadableBots(cause: unknown, file = BOTS_FILE): never {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const copy = keepUnreadableBots(file);
  throw new UnreadableBotsError([
    `The server did not start: bots.json cannot be read (${code ? `error ${code}` : "the content is not a list of bots"}).`,
    "The server did not change the file.",
    copy ? `A copy is at ${copy}.` : "No copy could be made.",
    "Restore bots.json, fix its permissions, or move it away, then start the server again.",
  ].join(" "));
}

/** A refusal is one plain line and exit code 1, never a stack trace. */
export function openStoreOrExit<T>(open: () => T, exit: (code: number) => never = (code) => process.exit(code)): T {
  try {
    return open();
  } catch (error) {
    if (!(error instanceof UnreadableBotsError)) throw error;
    console.error(error.message);
    return exit(1);
  }
}
