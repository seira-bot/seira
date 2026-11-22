import nodeFs from "node:fs";
import path from "node:path";

export const MAX_QUEUED_REPORTS = 30;
export const MAX_QUEUED_BYTES = 10 * 1024 * 1024;
const SENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_KEEP_COUNT = 500;
const REPORT_FILE = /^(\d{14})-([0-9a-f]{32})-([a-z]+(?:-[a-z]+)*)\.json$/;
const ID = /^[0-9a-f]{32}$/;
const KIND = /^[a-z]+(?:-[a-z]+)*$/;

/** One file per report in a folder only this app reads. Every failure drops the report and returns, never throws (a full disk must not stop the app). */
export function createCrashQueue({ dir, fs = nodeFs, now = Date.now, maxFiles = MAX_QUEUED_REPORTS, maxBytes = MAX_QUEUED_BYTES }) {
  const own = (name) => path.join(dir, name);
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  function writeAtomic(name, data) {
    ensure();
    const temporary = own(`${name}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporary, data, { mode: 0o600 });
      fs.renameSync(temporary, own(name));
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }

  function list() {
    try {
      const entries = [];
      for (const name of fs.readdirSync(dir)) {
        const match = REPORT_FILE.exec(name);
        if (!match) continue;
        let size = 0;
        try { size = fs.statSync(own(name)).size; } catch { continue; }
        entries.push({ name, id: match[2], kind: match[3], size });
      }
      return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return [];
    }
  }

  function remove(entry) {
    try { fs.rmSync(own(entry.name), { force: true }); } catch {}
  }

  function trim() {
    let entries = list();
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    while (entries.length > 0 && (entries.length > maxFiles || bytes > maxBytes)) {
      const [oldest, ...rest] = entries;
      remove(oldest);
      bytes -= oldest.size;
      entries = rest;
    }
  }

  function readJson(name) {
    try { return JSON.parse(fs.readFileSync(own(name), "utf8")); } catch { return null; }
  }

  function writeJson(name, value) {
    try { writeAtomic(name, JSON.stringify(value)); return true; } catch { return false; }
  }

  return {
    dir,
    list,
    remove,
    readJson,
    writeJson,
    /** false when the report was not stored. */
    add(id, kind, body) {
      try {
        if (!ID.test(id) || !KIND.test(kind) || typeof body !== "string" || Buffer.byteLength(body) > maxBytes) return false;
        const name = `${String(now()).padStart(14, "0")}-${id}-${kind}.json`;
        writeAtomic(name, body);
        trim();
        return list().some((entry) => entry.name === name);
      } catch {
        return false;
      }
    },
    read(entry) {
      try { return fs.readFileSync(own(entry.name), "utf8"); } catch { return null; }
    },
    /** Deletes every waiting report; state.json and session.json stay. */
    clear() {
      for (const entry of list()) remove(entry);
      try {
        for (const name of fs.readdirSync(dir)) if (name.endsWith(".tmp")) fs.rmSync(own(name), { force: true });
      } catch {}
    },
    state() {
      const saved = readJson("state.json");
      const retryAfterUntil = Number.isFinite(saved?.retryAfterUntil) ? saved.retryAfterUntil : 0;
      const sent = Array.isArray(saved?.sent)
        ? saved.sent.filter((item) => Number.isFinite(item?.at) && typeof item?.id === "string" && ID.test(item.id))
          .map((item) => ({ at: item.at, id: item.id }))
        : [];
      return { retryAfterUntil, sent };
    },
    saveState(state) {
      const cutoff = now() - SENT_KEEP_MS;
      const sent = state.sent.filter((item) => item.at >= cutoff).slice(-SENT_KEEP_COUNT);
      return writeJson("state.json", { retryAfterUntil: state.retryAfterUntil, sent });
    },
  };
}
