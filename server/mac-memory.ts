import { execFile } from "node:child_process";
import os from "node:os";

export interface MacMemory { totalBytes: number; availableBytes: number }

export interface VmStat {
  pageBytes: number;
  freePages: number;
  inactivePages: number;
  speculativePages: number;
  purgeablePages: number;
  availableBytes: number;
}

const pages = (text: string, label: string): number | null => {
  const found = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
  return found ? Number(found[1]) : null;
};

/** `vm_stat` prints "Pages free" without the speculative pages, and the page size is 16384 bytes on Apple silicon. Inactive pages
 * are reclaimable, which `os.freemem()` does not count on macOS. Purgeable pages are already on the inactive or active queue, so
 * they are not added again. */
export function parseVmStat(text: string): VmStat | null {
  const size = /page size of (\d+) bytes/.exec(text);
  const pageBytes = size ? Number(size[1]) : 0;
  const freePages = pages(text, "Pages free");
  if (!(pageBytes > 0) || freePages === null) return null;
  const inactivePages = pages(text, "Pages inactive") ?? 0;
  const speculativePages = pages(text, "Pages speculative") ?? 0;
  const purgeablePages = pages(text, "Pages purgeable") ?? 0;
  return { pageBytes, freePages, inactivePages, speculativePages, purgeablePages, availableBytes: (freePages + inactivePages + speculativePages) * pageBytes };
}

export interface MacMemoryOptions {
  /** The text `vm_stat` prints, or null when it cannot run. */
  run?: () => Promise<string | null>;
  total?: () => number;
  fallbackFree?: () => number;
  now?: () => number;
  maxAgeMs?: number;
}

const runVmStat = (): Promise<string | null> => new Promise((resolve) => {
  execFile("vm_stat", [], { timeout: 5_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
});

export function createMacMemoryReader(options: MacMemoryOptions = {}) {
  const run = options.run ?? runVmStat;
  const total = options.total ?? (() => os.totalmem());
  const fallbackFree = options.fallbackFree ?? (() => os.freemem());
  const now = options.now ?? (() => Date.now());
  const maxAgeMs = options.maxAgeMs ?? 2_000;
  let availableBytes: number | null = null;
  let answeredAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let text: string | null = null;
      try { text = await run(); } catch { text = null; }
      availableBytes = text === null ? null : parseVmStat(text)?.availableBytes ?? null;
      answeredAt = now();
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const read = (): MacMemory => {
    if (answeredAt === null || now() - answeredAt >= maxAgeMs) void refresh();
    const totalBytes = total();
    const raw = availableBytes ?? fallbackFree();
    return { totalBytes, availableBytes: Math.min(Math.max(raw, 0), totalBytes) };
  };

  return { read, refresh };
}
