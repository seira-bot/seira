import fs from "node:fs";
import path from "node:path";

// Times are milliseconds since the main process started: performance.now() counts from process start in Node.
export function createStartupTimeline({ now = () => performance.now(), env = process.env, writeFile = fs.writeFileSync } = {}) {
  const marks = new Map();
  let log = null;
  let finished = false;

  const record = (name) => {
    if (finished || marks.has(name)) return;
    marks.set(name, Math.round(now()));
  };

  return {
    start(logFn) {
      log = logFn;
      record("app-ready");
    },
    mark: record,
    finish(name) {
      if (finished) return;
      record(name);
      finished = true;
      try {
        log?.(`startup timeline ${[...marks].map(([key, ms]) => `${key}=${ms}ms`).join(" ")}`);
      } catch {}
      const target = env.SEIRA_STARTUP_TIMELINE;
      if (typeof target !== "string" || !target || !path.isAbsolute(target)) return;
      try {
        writeFile(target, JSON.stringify({ marks: Object.fromEntries(marks) }));
      } catch {}
    },
    snapshot() {
      return Object.fromEntries(marks);
    },
  };
}

export const startupTimeline = createStartupTimeline();
