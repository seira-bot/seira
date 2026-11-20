import { cleanup } from "./cleanup";
import { HTTPError, errorResponse, json, logFailure } from "./common";
import type { AppEnv, Deps } from "./env";
import { authenticate, deleteSelf, enroll, rotate, type Caller } from "./installations";
import { rateKeyOf } from "./ip";
import { activity, registerDevice, sendPush, unregisterDevice } from "./push";
import { readApnsConfig } from "./push-apns";
import { readFcmConfig } from "./push-fcm";

const defaultDeps: Deps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
};

type Handler = (request: Request, caller: Caller, env: AppEnv, deps: Deps) => Promise<Response> | Response;

const SELF = "/v1/installations/self";

/** Routes that need a Bearer credential. `push` routes also stop while PUSH_PAUSED is "true". */
const BEARER_ROUTES: Record<string, { method: string; push: boolean; handler: Handler }> = {
  [`${SELF}/push/register`]: { method: "POST", push: true, handler: (request, caller, env, deps) => registerDevice(request, caller, env, deps) },
  [`${SELF}/push/unregister`]: { method: "POST", push: false, handler: (request, caller, env) => unregisterDevice(request, caller, env) },
  [`${SELF}/push/send`]: { method: "POST", push: true, handler: (request, caller, env, deps) => sendPush(request, caller, env, deps) },
  [`${SELF}/push/activity`]: { method: "POST", push: true, handler: () => activity() },
  [`${SELF}/credentials/rotate`]: { method: "POST", push: false, handler: (_request, caller, env, deps) => rotate(caller, env, deps) },
  [SELF]: { method: "DELETE", push: false, handler: (_request, caller, env) => deleteSelf(caller, env) },
};

const PUBLIC_METHODS: Record<string, string> = { "/healthz": "GET", "/v1/push/enroll": "POST" };

async function route(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  // A browser page has no business here. Only the Seira server calls this Worker.
  if (request.headers.has("origin")) return errorResponse(403, "forbidden");
  const { pathname } = new URL(request.url);
  const bearer = Object.hasOwn(BEARER_ROUTES, pathname) ? BEARER_ROUTES[pathname]! : null;
  const method = bearer?.method ?? (Object.hasOwn(PUBLIC_METHODS, pathname) ? PUBLIC_METHODS[pathname] : undefined);
  if (!method) return errorResponse(404, "not_found");
  if (request.method !== method) return json({ error: "method_not_allowed" }, 405, { allow: method });

  if (pathname === "/healthz") {
    return json({ ok: true, service: "seira-push", apns: readApnsConfig(env) !== null, fcm: readFcmConfig(env) !== null });
  }
  const ip = request.headers.get("cf-connecting-ip");
  if (!(await env.REQUEST_LIMITER.limit({ key: ip ? rateKeyOf(ip) : "unknown" })).success) return errorResponse(429, "rate_limited", 60);

  if (!bearer) return enroll(request, env, deps);
  if (bearer.push && env.PUSH_PAUSED === "true") return errorResponse(503, "push_unavailable");
  return bearer.handler(request, await authenticate(request, env, deps), env, deps);
}

export async function handle(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  try {
    return await route(request, env, deps);
  } catch (error) {
    if (error instanceof HTTPError) return errorResponse(error.status, error.code, error.retryAfter);
    logFailure({ message: "unhandled error", status: 500 });
    return errorResponse(500, "internal_error");
  }
}

export default {
  fetch: (request: Request, env: AppEnv) => handle(request, env, defaultDeps),
  scheduled: async (_controller: ScheduledController, env: AppEnv) => {
    await cleanup(env, defaultDeps.now());
  },
};
