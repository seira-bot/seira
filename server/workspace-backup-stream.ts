// Export without a full snapshot copy: pass 1 reads each file once for its size and hash, pass 2 streams the same bytes into the tar
// and the cipher and checks them against pass 1. A file that changed between or during the reads stops the export.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readlinkSync, readSync, statSync, writeSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { restoreBeat } from "./restore-progress.ts";

export type StreamSource = {
  /** The file the bytes come from: the real file, after a link inside a workspace was followed. */
  source: string;
  /** Where the walk found it. A link that is replaced later, or a parent folder that is swapped, changes this. */
  originKey: string; root: string; ancestors: string[]; origin: string; stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
};
export type HashedFile = { copied: { size: number; mode: number; sha256: string }; stream: StreamSource };
export type ArchiveEntry = { path: string; type: "file" | "directory"; size: number; mode: number; sha256?: string };

const CHANGED = (path: string) => new Error(`A workspace file changed during backup: ${path}. Stop its writer and retry.`);
const keyOf = (path: string) => {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}:${stat.isSymbolicLink() ? `link:${readlinkSync(path)}` : stat.isFile() ? "file" : "other"}`;
};
/** The identity of every folder from the approved root down to the file: a swap of any of them changes the list. Fail closed. */
const ancestorKeys = (root: string, file: string): string[] => {
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("A workspace file is outside the folder the export approved.");
  const keys: string[] = []; let folder = root;
  const top = statSync(root); keys.push(`${top.dev}:${top.ino}`);
  for (const part of dirname(rel).split(sep).filter((name) => name && name !== ".")) {
    folder = `${folder}${sep}${part}`;
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("A workspace folder on the path of a file is not a plain folder.");
    keys.push(`${stat.dev}:${stat.ino}`);
  }
  return keys;
};
const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index]);
const sameStat = (a: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">, b: StreamSource["stat"]) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** A restore's copy of one staged file, with the same checks. */
export function copyRegular(source: string, destination: string, limit: number): { size: number; mode: number; sha256: string } {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile() || before.size > limit) throw new Error("A workspace file is not regular or exceeds the 10 GB backup limit.");
    const mode = before.mode & 0o100 ? 0o700 : 0o600;
    output = openSync(destination, "wx", mode);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > before.size) throw new Error("A workspace file changed during backup. Stop its writer and retry.");
      hash.update(chunk.subarray(0, count)); restoreBeat();
      let offset = 0;
      while (offset < count) offset += writeSync(output, chunk, offset, count - offset);
    }
    const after = fstatSync(input);
    const current = lstatSync(source);
    if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) {
      throw new Error("A workspace file changed during backup. Stop its writer and retry.");
    }
    fsyncSync(output);
    return { size, mode, sha256: hash.digest("hex") };
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}
export type HashScope = {
  /** The approved folder the file must stay in. */
  root: string;
  /** The identity the walk saw for the file; the opened file must be the same one. */
  walked?: { dev: number; ino: number };
  /** The exclusion policy, applied to the path of the file that is really opened. */
  allowed?: (relativePath: string) => boolean;
  /** Keep the bytes this read saw (small metadata only), so a count comes from the bytes that are archived. */
  keep?: boolean;
};
/** One read of a file for its size and SHA-256, with the identity, size and change-time checks of a copy, and nothing written. */
export function hashRegular(source: string, origin: string, limit: number, label: string, scope: HashScope): HashedFile & { bytes?: Buffer } {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(input);
    if (!before.isFile() || before.size > limit) {
      throw new Error(scope.keep ? `A workspace roster is not regular or exceeds the 16 MiB metadata limit: ${label}` : `A workspace file is not regular or exceeds the 10 GB backup limit: ${label}`);
    }
    if (scope.walked && (before.dev !== scope.walked.dev || before.ino !== scope.walked.ino)) throw CHANGED(label);
    const rel = relative(scope.root, source).split(sep).join("/");
    if (scope.allowed && !scope.allowed(rel)) throw CHANGED(label);
    const originKey = keyOf(origin);
    const ancestors = ancestorKeys(scope.root, source);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    const hash = createHash("sha256");
    const kept: Buffer[] = [];
    let size = 0;
    for (;;) {
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > before.size) throw CHANGED(label);
      hash.update(chunk.subarray(0, count)); restoreBeat();
      if (scope.keep) kept.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fstatSync(input);
    const current = lstatSync(source);
    if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink() || keyOf(origin) !== originKey || !sameKeys(ancestors, ancestorKeys(scope.root, source))) throw CHANGED(label);
    const stat = { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
    return { copied: { size, mode: before.mode & 0o100 ? 0o700 : 0o600, sha256: hash.digest("hex") }, stream: { source, origin, originKey, root: scope.root, ancestors, stat }, ...(scope.keep ? { bytes: Buffer.concat(kept) } : {}) };
  } finally { closeSync(input); }
}

/** The bytes of one file, as pass 1 saw them; any difference throws with the workspace-relative path. */
function* fileBytes(path: string, entry: ArchiveEntry, from: StreamSource): Generator<Buffer> {
  const fail = () => CHANGED(path);
  if (keyOf(from.origin) !== from.originKey || !sameKeys(ancestorKeys(from.root, from.source), from.ancestors)) throw fail();
  const input = openSync(from.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(input);
    if (!before.isFile() || !sameStat(before, from.stat)) throw fail();
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > entry.size) throw fail();
      const bytes = chunk.subarray(0, count);
      hash.update(bytes); restoreBeat();
      yield bytes;
    }
    const after = fstatSync(input);
    if (size !== entry.size || !sameStat(after, from.stat) || hash.digest("hex") !== entry.sha256 ||
      keyOf(from.origin) !== from.originKey || !sameKeys(ancestorKeys(from.root, from.source), from.ancestors)) throw fail();
    if (size % 512) yield Buffer.alloc(512 - (size % 512));
  } finally { closeSync(input); }
}

/** The tar the archive holds: `manifest.json`, then `data/`, then every entry, written from the files themselves. */
export async function* archiveBlocks(manifest: HashedFile, entries: readonly ArchiveEntry[], streams: ReadonlyMap<string, StreamSource>): AsyncGenerator<Buffer> {
  const { Header, Pax } = await import("tar");
  const header = (path: string, type: "File" | "Directory", mode: number, size: number): Buffer[] => {
    const head = new Header({ path, type, mode, size, uid: 0, gid: 0 });
    const long = head.encode() ? [new Pax({ path, size }).encode()] : [];
    return [...long, head.block!];
  };
  yield* header("manifest.json", "File", 0o600, manifest.copied.size);
  yield* fileBytes("manifest.json", { path: "manifest.json", type: "file", ...manifest.copied }, manifest.stream);
  yield* header("data/", "Directory", 0o700, 0);
  for (const entry of entries) {
    if (entry.type === "directory") { yield* header(`data/${entry.path}/`, "Directory", 0o700, 0); continue; }
    const from = streams.get(entry.path);
    if (!from) throw new Error(`A workspace file has no source: ${entry.path}`);
    yield* header(`data/${entry.path}`, "File", entry.mode, entry.size);
    yield* fileBytes(entry.path, entry, from);
  }
  yield Buffer.alloc(1024);
}
