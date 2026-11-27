import type { IncomingMessage, ServerResponse } from "node:http";
import { ROUTE_TEMPLATES } from "./access-log-routes.ts";

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

interface RouteNode {
  end: boolean;
  fixed: Map<string, RouteNode>;
  id?: RouteNode;
}

const newNode = (): RouteNode => ({ end: false, fixed: new Map() });
const ROUTES = newNode();
for (const template of ROUTE_TEMPLATES) {
  let node = ROUTES;
  for (const part of template.split("/").slice(1)) {
    if (part === ":id") node = node.id ??= newNode();
    else {
      let next = node.fixed.get(part);
      if (!next) node.fixed.set(part, (next = newNode()));
      node = next;
    }
  }
  node.end = true;
}

/** The route of the path, never the path. Several known routes can share a prefix, and the route table does not say which one the server picks. So a word stays only when no known route reads that position as a name or an id. Any other part becomes :id, and what follows the last known part becomes <other>. A webhook path ends in <redacted>. The query string and the fragment are dropped, and a control character cannot start a second line. */
export function loggablePath(rawUrl: string | undefined): string {
  const path = (rawUrl ?? "/").split(/[?#]/, 1)[0];
  const parts = path.split("/").slice(1);
  if (parts.at(-1) === "") parts.pop();
  if (parts[0] === "hooks" && parts[1]?.startsWith("wh_") && parts.length > 2) return "/hooks/:id/<redacted>";
  if (path === "" || path === "/") return "/";
  const shape: string[] = [];
  let nodes = [ROUTES];
  for (const part of parts) {
    const next: RouteNode[] = [];
    let variable = false;
    for (const node of nodes) {
      const fixed = node.fixed.get(part);
      if (fixed) next.push(fixed);
      if (node.id) {
        next.push(node.id);
        variable = true;
      }
    }
    if (next.length === 0) break;
    shape.push(variable ? ":id" : part);
    nodes = next;
  }
  if (shape.length === 0) return "<other>";
  if (shape.length < parts.length || !nodes.some((node) => node.end)) shape.push("<other>");
  const clean = `/${shape.join("/")}`.replace(/[^\x21-\x7e]/g, "?");
  return clean.length > MAX_PATH ? `${clean.slice(0, MAX_PATH)}...` : clean;
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
