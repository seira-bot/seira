import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { BOTS_FILE, isListOfRecords } from "./registry-store.ts";

/** bots.json or groups.json is there, and it does not read as a list. */
export class UnreadableBotsError extends Error {}

/** A list of bots: every element is an object (not a list) with an `id` that is a text that is not empty. */
export const isListOfBots = isListOfRecords;

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
  const code = (cause as NodeJS.ErrnoException | undefined)?.code, name = basename(file);
  const copy = keepUnreadableBots(file);
  throw new UnreadableBotsError([
    `The server did not start: ${name} cannot be read (${code ? `error ${code}` : `the content is not a list of ${name === "groups.json" ? "rooms" : "bots"}`}).`,
    "The server did not change the file.",
    copy ? `A copy is at ${copy}.` : "No copy could be made.",
    `Restore ${name}, fix its permissions, or move it away, then start the server again.`,
  ].join(" "));
}

/** The bots that bots.json lists, or undefined when there is no file. A file that does not read as a list stops the start. */
export function loadBotsOrRefuse<T>(load: () => unknown, file = BOTS_FILE): T[] | undefined {
  try {
    const loaded = load();
    if (!isListOfBots(loaded)) throw new TypeError("bots.json is not a list of bots");
    return loaded as T[];
  } catch (error) {
    if (existsSync(file)) refuseUnreadableBots(error, file);
    return undefined;
  }
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
