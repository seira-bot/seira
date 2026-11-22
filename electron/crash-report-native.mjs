import nodeFs from "node:fs";
import path from "node:path";

const MAX_DEPTH = 3;

function dumpFiles(fs, dir, depth = 0, found = []) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of names) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) dumpFiles(fs, file, depth + 1, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dmp")) found.push(file);
  }
  return found;
}

/**
 * Privacy (AC-46): a minidump holds process memory, so no code here opens one. The folder is only counted, by file name
 * and modification time, and then emptied of dumps.
 * Returns how many dumps are newer than `since`.
 */
export function takeCrashDumps({ dir, since, fs = nodeFs }) {
  let fresh = 0;
  for (const file of dumpFiles(fs, dir)) {
    try {
      if (fs.statSync(file).mtimeMs >= since) fresh += 1;
    } catch {}
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return fresh;
}
