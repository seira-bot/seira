import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { pipeline, Transform, type Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import type { ImportErrorCode } from "../../shared/ai-import/api.ts";
import { safeArchivePath } from "../zip-archive.ts";

export class ImportUploadError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ImportUploadError";
  }
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
  method: 0 | 8;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_RECORD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX32 = 0xffffffff;
const EOCD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_RECORD_BYTES = 56;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const MAX_EOCD_SEARCH_BYTES = EOCD_BYTES + 0xffff;
const MAX_DIRECTORY_BYTES = 128 * 1024 * 1024;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_HOST = 3;

const unsafe = (message: string): ImportUploadError => new ImportUploadError("unsafe-archive", message);

/** The key two entry names share when a case-insensitive or normalizing file system would store them as one file. */
export function entryKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw unsafe("The archive has a size or offset that is too large.");
  return Number(value);
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw unsafe("The archive is truncated.");
    filled += bytesRead;
  }
  return buffer;
}

/** The data of the ZIP64 extra field (header id 0x0001, APPNOTE section 4.5.3), or null when the entry has none. */
function zip64Field(extra: Buffer): Buffer | null {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const end = cursor + 4 + extra.readUInt16LE(cursor + 2);
    if (end > extra.length) throw unsafe("The archive has a broken extra field.");
    if (id === 0x0001) return extra.subarray(cursor + 4, end);
    cursor = end;
  }
  return null;
}

interface Directory {
  count: number;
  bytes: number;
  offset: number;
}

async function locateDirectory(handle: FileHandle, fileSize: number, maxEntries: number): Promise<Directory> {
  const tailLength = Math.min(fileSize, MAX_EOCD_SEARCH_BYTES);
  const tailStart = fileSize - tailLength;
  const tail = await readAt(handle, tailLength, tailStart);
  let eocd = -1;
  for (let cursor = tail.length - EOCD_BYTES; cursor >= 0; cursor -= 1) {
    if (
      tail.readUInt32LE(cursor) === EOCD_SIGNATURE
      && cursor + EOCD_BYTES + tail.readUInt16LE(cursor + 20) === tail.length
    ) {
      eocd = cursor;
      break;
    }
  }
  if (eocd < 0) throw unsafe("The archive has no directory.");
  const eocdOffset = tailStart + eocd;

  let disk = tail.readUInt16LE(eocd + 4);
  let directoryDisk = tail.readUInt16LE(eocd + 6);
  let diskEntries = tail.readUInt16LE(eocd + 8);
  let count = tail.readUInt16LE(eocd + 10);
  let bytes = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);

  if (eocdOffset >= ZIP64_LOCATOR_BYTES) {
    const locator = await readAt(handle, ZIP64_LOCATOR_BYTES, eocdOffset - ZIP64_LOCATOR_BYTES);
    if (locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE) {
      const recordOffset = toNumber(locator.readBigUInt64LE(8));
      if (
        locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1
        || recordOffset + ZIP64_RECORD_BYTES > eocdOffset - ZIP64_LOCATOR_BYTES
      ) throw unsafe("The archive has an unsupported ZIP64 layout.");
      const record = await readAt(handle, ZIP64_RECORD_BYTES, recordOffset);
      if (record.readUInt32LE(0) !== ZIP64_RECORD_SIGNATURE) throw unsafe("The archive has a broken ZIP64 directory.");
      disk = record.readUInt32LE(16);
      directoryDisk = record.readUInt32LE(20);
      diskEntries = toNumber(record.readBigUInt64LE(24));
      count = toNumber(record.readBigUInt64LE(32));
      bytes = toNumber(record.readBigUInt64LE(40));
      offset = toNumber(record.readBigUInt64LE(48));
    }
  }

  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== count) throw unsafe("The archive spans several disks.");
  if (count > maxEntries) throw new ImportUploadError("too-many-files");
  if (bytes > MAX_DIRECTORY_BYTES || bytes < count * CENTRAL_HEADER_BYTES || offset + bytes > eocdOffset) {
    throw unsafe("The archive directory is broken.");
  }
  return { count, bytes, offset };
}

/**
 * Lists the files of one ZIP, including ZIP64. Every entry is checked: a bad path, link, duplicate name, encryption or
 * unknown method rejects the whole archive. Folder entries are checked and left out of the result.
 */
export async function readZipEntries(path: string, maxEntries: number): Promise<ZipEntryInfo[]> {
  const handle = await open(path, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const { count, bytes, offset } = await locateDirectory(handle, fileSize, maxEntries);
    const directory = await readAt(handle, bytes, offset);
    const entries: ZipEntryInfo[] = [];
    const seen = new Set<string>();
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + CENTRAL_HEADER_BYTES > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw unsafe("The archive directory is broken.");
      }
      const madeBy = directory.readUInt16LE(cursor + 4);
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let size = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const startDisk = directory.readUInt16LE(cursor + 34);
      const attributes = directory.readUInt32LE(cursor + 38);
      let localHeaderOffset = directory.readUInt32LE(cursor + 42);
      const nameStart = cursor + CENTRAL_HEADER_BYTES;
      const extraStart = nameStart + nameLength;
      const next = extraStart + extraLength + commentLength;
      if (next > directory.length) throw unsafe("The archive directory is broken.");
      if (startDisk !== 0) throw unsafe("The archive spans several disks.");
      if ((flags & 1) !== 0) throw unsafe("The archive has an encrypted file.");
      if (method !== 0 && method !== 8) throw unsafe("The archive uses an unsupported compression method.");

      if (size === MAX32 || compressedSize === MAX32 || localHeaderOffset === MAX32) {
        const field = zip64Field(directory.subarray(extraStart, extraStart + extraLength));
        if (!field) throw unsafe("The archive is missing its ZIP64 sizes.");
        let at = 0;
        const take = (): number => {
          if (at + 8 > field.length) throw unsafe("The archive is missing its ZIP64 sizes.");
          const value = toNumber(field.readBigUInt64LE(at));
          at += 8;
          return value;
        };
        if (size === MAX32) size = take();
        if (compressedSize === MAX32) compressedSize = take();
        if (localHeaderOffset === MAX32) localHeaderOffset = take();
      }

      const raw = directory.toString("utf8", nameStart, extraStart);
      const isDirectory = raw.endsWith("/");
      const name = isDirectory ? raw.slice(0, -1) : raw;
      if (!safeArchivePath(name)) throw unsafe("The archive has an unsafe file path.");
      if (madeBy >> 8 === UNIX_HOST) {
        const type = (attributes >>> 16) & UNIX_TYPE_MASK;
        if (type !== 0 && type !== UNIX_FILE && type !== UNIX_DIRECTORY) throw unsafe("The archive has a link or special file.");
      }
      const key = entryKey(name);
      if (seen.has(key)) throw unsafe("The archive has two files with the same name.");
      seen.add(key);
      if (localHeaderOffset + LOCAL_HEADER_BYTES > fileSize) throw unsafe("The archive directory is broken.");
      if (method === 0 && compressedSize !== size) throw unsafe("The archive has a stored file with two sizes.");

      if (!isDirectory) entries.push({ name, size, compressedSize, method, localHeaderOffset });
      cursor = next;
    }
    if (cursor !== directory.length) throw unsafe("The archive directory is broken.");
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * The declared size is only a claim. The stream stops with an error when more bytes come out than the entry declares,
 * and when fewer come out.
 */
function sizeGuard(declared: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > declared) callback(unsafe("A file in the archive is larger than it declares."));
      else callback(null, chunk);
    },
    flush(callback) {
      callback(seen === declared ? null : unsafe("A file in the archive is smaller than it declares."));
    },
  });
}

export async function openZipEntry(path: string, entry: ZipEntryInfo): Promise<Readable> {
  const handle = await open(path, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const header = await readAt(handle, LOCAL_HEADER_BYTES, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE || (header.readUInt16LE(6) & 1) !== 0) {
      throw unsafe("The archive has a broken file header.");
    }
    const start = entry.localHeaderOffset + LOCAL_HEADER_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + entry.compressedSize > fileSize) throw unsafe("The archive is truncated.");
    if (entry.compressedSize === 0) {
      await handle.close();
      return emptyEntry(entry);
    }
    const source = createReadStream(path, {
      fd: handle,
      start,
      end: start + entry.compressedSize - 1,
      autoClose: true,
    });
    const guard = sizeGuard(entry.size);
    if (entry.method === 8) pipeline(source, createInflateRaw(), guard, () => {});
    else pipeline(source, guard, () => {});
    return guard;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function emptyEntry(entry: ZipEntryInfo): Readable {
  if (entry.size !== 0) throw unsafe("A file in the archive is smaller than it declares.");
  const guard = sizeGuard(0);
  guard.end();
  return guard;
}
