import { json } from "./common";
import { isDryRun } from "./dry-run";
import type { AppEnv, Deps, TokenCache } from "./env";
import { handleReport } from "./report";
import { handleStatus } from "./status";

const defaultTokens: TokenCache = new Map();

const defaultDeps: Deps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
  tokens: defaultTokens,
};

async function route(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed." }, 405, { allow: "GET, HEAD" });
    }
    return new Response(isDryRun(env) ? "ok dry-run" : "ok", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  if (pathname === "/api/bug-reports" || pathname === "/api/bug-reports/status") {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });
    return pathname === "/api/bug-reports" ? handleReport(request, env, deps) : handleStatus(request, env, deps);
  }
  return json({ error: "Not found." }, 404);
}

export async function handle(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  try {
    return await route(request, env, deps);
  } catch (error) {
    console.error("unhandled", error instanceof Error ? error.name : "unknown");
    return json({ error: "Something went wrong. Try again later." }, 500);
  }
}

export default {
  fetch: (request: Request, env: AppEnv) => handle(request, env, defaultDeps),
};
