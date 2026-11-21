import { createInterface } from "node:readline/promises";

/** What `seira login --events` talks to: it asks for a code and reads the lines the caller sends back; null is the end of them. */
export interface LoginEvents {
  ask(email: string): void;
  readLine(): Promise<string | null>;
}

const CODE_LINE = /^code ([0-9]{8})$/;
export const CODE_ATTEMPTS = 3;

export async function readCodeLine(events: LoginEvents): Promise<string | null> {
  for (;;) {
    const line = await events.readLine();
    if (line === null) return null;
    const found = CODE_LINE.exec(line.replace(/\r$/, ""));
    if (found) return found[1]!;
  }
}

export function stdinLoginEvents(): LoginEvents & { close(): void } {
  const reader = createInterface({ input: process.stdin });
  const lines = reader[Symbol.asyncIterator]();
  return {
    ask: (email) => console.log(`::seira ask code ${email}`),
    readLine: async () => {
      const next = await lines.next();
      return next.done ? null : next.value;
    },
    close: () => reader.close(),
  };
}
