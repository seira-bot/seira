import type { IncomingMessage, ServerResponse } from "node:http";

export type AccessRoute = "local" | "tunnel";

export interface AccessEntry {
  time: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  route: AccessRoute;
}

const MAX_PATH = 200;

export function accessLogEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SEIRA_ACCESS_LOG === "1";
}

/** The path alone. The query string, the fragment and a webhook secret never reach a log line, and a control character cannot start a second line. */
export function loggablePath(rawUrl: string | undefined): string {
  const path = (rawUrl ?? "/").split(/[?#]/, 1)[0].replace(/^(\/hooks\/wh_[^/]*\/).*$/, "$1<redacted>");
  const clean = path.replace(/[^\x21-\x7e]/g, "?");
  return clean.length > MAX_PATH ? `${clean.slice(0, MAX_PATH)}...` : clean || "/";
}

export function formatAccessLine(entry: AccessEntry): string {
  const method = entry.method.replace(/[^A-Z]/gi, "?").slice(0, 16) || "?";
  return `access ${entry.time.toISOString()} ${method} ${entry.path} ${entry.status} ${Math.round(entry.durationMs)}ms via=${entry.route}`;
}

/** Writes one line when the response ends, or when the connection closes before it does (status as sent so far). Off unless SEIRA_ACCESS_LOG=1. */
export function withAccessLog<T>(
  handle: (req: IncomingMessage, res: ServerResponse) => T,
  route: AccessRoute,
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => console.log(line),
) {
  if (!accessLogEnabled(env)) return handle;
  return (req: IncomingMessage, res: ServerResponse): T => {
    const start = performance.now();
    const time = new Date();
    let written = false;
    const finish = () => {
      if (written) return;
      written = true;
      write(formatAccessLine({ time, method: req.method ?? "", path: loggablePath(req.url), status: res.statusCode, durationMs: performance.now() - start, route }));
    };
    res.once("finish", finish);
    res.once("close", finish);
    return handle(req, res);
  };
}
