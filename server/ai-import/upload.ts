import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import type { ImportEntry, ImportFiles } from "./reader.ts";
import { entryKey, ImportUploadError, openZipEntry, readZipEntries, type ZipEntryInfo } from "./zip-reader.ts";

export { ImportUploadError };

export interface ImportLimits {
  uploadBytes: number;
  extractedBytes: number;
  entries: number;
  jsonMemberBytes: number;
  otherMemberBytes: number;
  compressionRatio: number;
}

export interface UploadPart {
  path: string;
  name: string;
}

const MIB = 1024 * 1024;
const FALLBACK_NAME = "upload.json";
const MAX_NAME_CHARACTERS = 200;

/** The compression ratio is not checked below this size: a small file of zeros is not a bomb. */
const RATIO_MIN_BYTES = MIB;

/** The base name of an uploaded file, safe to show and to use as an entry name. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? "";
  const clean = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .slice(0, MAX_NAME_CHARACTERS)
    .join("")
    .trim();
  return clean === "" || clean === "." || clean === ".." ? FALLBACK_NAME : clean;
}

const isJson = (name: string): boolean => name.toLowerCase().endsWith(".json");

const memberLimit = (name: string, limits: ImportLimits): number =>
  isJson(name) ? limits.jsonMemberBytes : limits.otherMemberBytes;

async function isZip(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && head[0] === 0x50 && head[1] === 0x4b
      && ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06));
  } finally {
    await handle.close();
  }
}

async function singleFile(part: UploadPart, size: number, limits: ImportLimits): Promise<ImportFiles> {
  const name = safeFileName(part.name);
  if (size > memberLimit(name, limits)) throw new ImportUploadError("too-much-data");
  return {
    entries: [{ name, size }],
    open: async (wanted: string): Promise<Readable> => {
      if (wanted !== name) throw new Error(`No entry named ${wanted}`);
      return createReadStream(part.path);
    },
  };
}

async function zipParts(parts: readonly UploadPart[], limits: ImportLimits): Promise<ImportFiles> {
  const sources = new Map<string, { path: string; info: ZipEntryInfo }>();
  const keys = new Set<string>();
  for (const part of parts) {
    for (const info of await readZipEntries(part.path, limits.entries)) {
      const key = entryKey(info.name);
      if (keys.has(key)) throw new ImportUploadError("unsafe-archive", "Two parts of the upload have a file with the same name.");
      keys.add(key);
      sources.set(info.name, { path: part.path, info });
    }
    if (sources.size > limits.entries) throw new ImportUploadError("too-many-files");
  }

  let extracted = 0;
  for (const { info } of sources.values()) extracted += info.size;
  if (extracted > limits.extractedBytes) throw new ImportUploadError("too-much-data");

  for (const { info } of sources.values()) {
    if (info.size > memberLimit(info.name, limits)) throw new ImportUploadError("too-much-data");
    if (info.size > RATIO_MIN_BYTES && info.size / Math.max(info.compressedSize, 1) > limits.compressionRatio) {
      throw new ImportUploadError("unsafe-archive", "A file in the archive is compressed far more than a real file is.");
    }
  }

  const entries: ImportEntry[] = [...sources.values()]
    .map(({ info }) => ({ name: info.name, size: info.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    entries,
    open: async (name: string): Promise<Readable> => {
      const source = sources.get(name);
      if (!source) throw new Error(`No entry named ${name}`);
      return openZipEntry(source.path, source.info);
    },
  };
}

/**
 * Turns uploaded files into one `ImportFiles`: one JSON file, one ZIP, or several ZIP parts read as one archive.
 * A ZIP is found by its first bytes, not by its file name. Any limit or safety failure throws and imports nothing.
 */
export async function openUploads(parts: UploadPart[], limits: ImportLimits = AI_IMPORT_LIMITS): Promise<ImportFiles> {
  if (parts.length === 0) throw new ImportUploadError("unknown-source");
  const sizes = await Promise.all(parts.map(async (part) => (await stat(part.path)).size));
  if (sizes.reduce((sum, size) => sum + size, 0) > limits.uploadBytes) throw new ImportUploadError("upload-too-large");
  const zips = await Promise.all(parts.map((part) => isZip(part.path)));
  if (zips.every(Boolean)) return zipParts(parts, limits);
  const [only] = parts;
  if (parts.length === 1 && only && !zips[0]) return singleFile(only, sizes[0] ?? 0, limits);
  throw new ImportUploadError("unknown-source");
}

export interface StoredUpload {
  id: string;
  path: string;
  name: string;
  bytes: number;
  at: number;
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface UploadMeta {
  name: string;
  bytes: number;
  at: number;
}

function readMeta(folder: string): UploadMeta | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { name, bytes, at } = value as Record<string, unknown>;
    if (typeof name !== "string" || typeof bytes !== "number" || typeof at !== "number") return null;
    return { name, bytes, at };
  } catch {
    return null;
  }
}

function byteLimit(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) callback(new ImportUploadError("upload-too-large"));
      else callback(null, chunk);
    },
  });
}

/** Uploads wait in `dir`, one private folder for each, until an import reads them or they expire. */
export function createUploadStore(dir: string) {
  const folderOf = (id: string): string => join(dir, id);

  return {
    async save(body: Readable, name: string, maxBytes: number = AI_IMPORT_LIMITS.uploadBytes): Promise<StoredUpload> {
      ensurePrivateDir(dir);
      const id = randomUUID();
      const folder = folderOf(id);
      const path = join(folder, "file");
      mkdirSync(folder, { mode: 0o700 });
      try {
        const counter = byteLimit(maxBytes);
        await pipeline(body, counter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        const saved: UploadMeta = { name: safeFileName(name), bytes: statSync(path).size, at: Date.now() };
        writeFileSync(join(folder, "meta.json"), JSON.stringify(saved), { mode: 0o600 });
        return { id, path, ...saved };
      } catch (error) {
        rmSync(folder, { recursive: true, force: true });
        throw error;
      }
    },

    get(id: string): StoredUpload | null {
      if (!UPLOAD_ID.test(id)) return null;
      const folder = folderOf(id);
      const meta = readMeta(folder);
      if (!meta) return null;
      const path = join(folder, "file");
      try {
        if (!statSync(path).isFile()) return null;
      } catch {
        return null;
      }
      return { id, path, ...meta };
    },

    remove(id: string): void {
      if (!UPLOAD_ID.test(id)) return;
      rmSync(folderOf(id), { recursive: true, force: true });
    },

    sweep(olderThanMs: number, now: number = Date.now()): number {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const id of names) {
        if (!UPLOAD_ID.test(id)) continue;
        const folder = folderOf(id);
        let at: number;
        try {
          at = readMeta(folder)?.at ?? statSync(folder).mtimeMs;
        } catch {
          continue;
        }
        if (now - at > olderThanMs) {
          rmSync(folder, { recursive: true, force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };
}
