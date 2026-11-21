import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ImportEvent } from "../../../shared/ai-import/bundle.ts";
import { folderFiles } from "../files.ts";
import type { ImportFiles, SourceReader } from "../reader.ts";

export function fixtureFolder(...parts: string[]): string {
  return fileURLToPath(new URL(`./${parts.join("/")}`, import.meta.url));
}

export function memFiles(content: Record<string, string | Buffer>): ImportFiles {
  const entries = Object.entries(content).map(([name, body]) => ({ name, size: Buffer.byteLength(body) }));
  return {
    entries,
    open: async (name) => {
      const body = content[name];
      if (body === undefined) throw new Error(`No entry named ${name}`);
      return Readable.from([Buffer.from(body)]);
    },
  };
}

export function spyFiles(files: ImportFiles): { files: ImportFiles; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    files: {
      entries: files.entries,
      open: async (name) => {
        opened.push(name);
        return files.open(name);
      },
    },
  };
}

export function prefixed(files: ImportFiles, prefix: string): ImportFiles {
  return {
    entries: files.entries.map((entry) => ({ ...entry, name: `${prefix}${entry.name}` })),
    open: (name) => files.open(name.slice(prefix.length)),
  };
}

export function without(files: ImportFiles, name: string): ImportFiles {
  return { entries: files.entries.filter((entry) => entry.name !== name), open: files.open };
}

export async function fixtureFiles(...parts: string[]): Promise<ImportFiles> {
  return folderFiles(fixtureFolder(...parts));
}

export async function collectEvents(reader: SourceReader, files: ImportFiles, signal: AbortSignal = new AbortController().signal): Promise<ImportEvent[]> {
  const events: ImportEvent[] = [];
  for await (const event of reader.read({ from: "files", files }, { signal, stagingDir: "", transcripts: true })) events.push(event);
  return events;
}
