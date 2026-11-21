import type { Readable } from "node:stream";
import type { InstructionsAs } from "../../shared/ai-import/api.ts";
import type { ImportEvent, ImportSourceKind } from "../../shared/ai-import/bundle.ts";

/** `name` uses "/" separators and is relative to the root of the upload or folder. */
export interface ImportEntry {
  name: string;
  size: number;
}

export interface ImportFiles {
  entries: readonly ImportEntry[];
  open(name: string): Promise<Readable>;
}

/** `path` is the source's home folder on the machine that runs the server. Readers never write inside it. */
export interface LocalSource {
  id: string;
  kind: ImportSourceKind;
  path: string;
  name: string;
  profile?: string;
}

export type ImportInput = { from: "files"; files: ImportFiles } | { from: "local"; source: LocalSource };

export interface ReaderContext {
  signal: AbortSignal;
  /** A private folder the reader may write copies into; the engine deletes it. */
  stagingDir: string;
  transcripts: boolean;
  instructions: InstructionsAs;
}

export interface SourceReader {
  kind: ImportSourceKind;
  sniff(files: ImportFiles): Promise<boolean>;
  read(input: ImportInput, ctx: ReaderContext): AsyncIterable<ImportEvent>;
}

export function unbuiltReader(kind: ImportSourceKind): SourceReader {
  return {
    kind,
    sniff: async () => false,
    read: () => {
      throw new Error(`The ${kind} reader is not built`);
    },
  };
}
