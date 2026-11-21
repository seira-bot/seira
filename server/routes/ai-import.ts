import { z } from "zod";

import { AI_IMPORT_FILE_NAME_HEADER, AI_IMPORT_PATH, type ApplyImportJob, type CreateImportJob } from "../../shared/ai-import/api.ts";
import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import { ImportJobError, type AiImportJobs } from "../ai-import/job.ts";
import { ImportUploadError } from "../ai-import/upload.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AiImportRouteDeps {
  jobs: AiImportJobs;
  /** True only where the person at this computer runs Seira, so this computer's folders are theirs to read. */
  local: boolean;
}

const JOB_ID = /^[A-Za-z0-9-]{1,64}$/u;
const MAX_UPLOADS = 20;
const MAX_LINES = 2_000;
const JSON_BODY_BYTES = 1_048_576;

const destinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }).strict(),
  z.object({ kind: z.literal("bot"), botId: z.string().min(1).max(200) }).strict(),
]);
const lines = z.array(z.string().max(AI_IMPORT_LIMITS.pasteChars)).max(MAX_LINES);
const createSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("upload"), uploadIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_UPLOADS) }).strict(),
  z.object({ from: z.literal("local"), sourceId: z.string().min(1).max(200), transcripts: z.boolean().optional(), instructions: z.enum(["persona", "about-you"]).optional() }).strict(),
  z.object({
    from: z.literal("paste"),
    ai: z.enum(["chatgpt", "claude-ai", "gemini", "grok", "copilot", "other"]),
    aboutYou: lines,
    howToReply: lines,
    destination: destinationSchema,
  }).strict(),
]);
const applySchema = z.object({ destinations: z.record(z.string().min(1).max(200), destinationSchema) }).strict();

const sameMachine = (deps: AiImportRouteDeps, auth: RequestAuth) => deps.local && auth.kind === "loopback" && auth.trust !== "service";
const jsonType = (type: string | undefined) => String(type ?? "").toLowerCase().startsWith("application/json");

/** Every route needs the owner or an admin. Reading this computer's folders also needs the person at this computer. */
export function createAiImportRoutes(deps: AiImportRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== AI_IMPORT_PATH && !path.startsWith(`${AI_IMPORT_PATH}/`)) return PASS;
    const rest = path.slice(AI_IMPORT_PATH.length).split("/").filter(Boolean);
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "forbidden" });
    res.setHeader("Cache-Control", "no-store");
    const body = async <T>(schema: z.ZodType<T>): Promise<T | null> => {
      // A page in a browser cannot send this type across origins.
      if (!jsonType(req.headers["content-type"])) {
        json(res, 415, { error: "invalid" });
        return null;
      }
      let raw: unknown;
      try {
        raw = await readBody(req, JSON_BODY_BYTES);
      } catch (error) {
        const status = (error as { status?: number }).status;
        json(res, status === 413 ? 413 : 400, { error: status === 413 ? "too-much-data" : "invalid" });
        return null;
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: "invalid" });
        return null;
      }
      return parsed.data;
    };
    try {
      const [head, id, action, extra] = rest;
      if (head === "uploads" && rest.length === 1) {
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        // The name header also makes a browser on another origin ask first, which this server never allows.
        const name = req.headers[AI_IMPORT_FILE_NAME_HEADER];
        if (typeof name !== "string" || !name.trim()) return json(res, 400, { error: "invalid" });
        let decoded: string;
        try {
          decoded = decodeURIComponent(name);
        } catch {
          decoded = name;
        }
        const length = Number(req.headers["content-length"] ?? "0");
        if (Number.isFinite(length) && length > AI_IMPORT_LIMITS.uploadBytes) return json(res, 413, { error: "upload-too-large" });
        const saved = await deps.jobs.uploads.save(req, decoded);
        return json(res, 200, { uploadId: saved.id });
      }
      if (head === "local" && rest.length === 1) {
        if (method !== "GET") return json(res, 405, { error: "method not allowed" });
        if (!sameMachine(deps, auth)) return json(res, 403, { error: "forbidden" });
        return json(res, 200, { sources: await deps.jobs.localSources() });
      }
      if (head !== "jobs" || extra !== undefined) return json(res, 404, { error: "not-found" });
      if (id === undefined) {
        if (method === "GET") return json(res, 200, { jobs: deps.jobs.list() });
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const input = await body<CreateImportJob>(createSchema);
        if (!input) return;
        if (input.from === "local" && !sameMachine(deps, auth)) return json(res, 403, { error: "forbidden" });
        return json(res, 200, await deps.jobs.create(input));
      }
      if (!JOB_ID.test(id)) return json(res, 404, { error: "not-found" });
      if (action === undefined) {
        if (method !== "GET") return json(res, 405, { error: "method not allowed" });
        return json(res, 200, deps.jobs.get(id));
      }
      if (action !== "apply" && action !== "cancel" && action !== "undo") return json(res, 404, { error: "not-found" });
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (action === "apply") {
        const input = await body<ApplyImportJob>(applySchema);
        if (!input) return;
        return json(res, 200, deps.jobs.apply(id, input));
      }
      return json(res, 200, action === "cancel" ? await deps.jobs.cancel(id) : deps.jobs.undo(id));
    } catch (error) {
      if (error instanceof ImportJobError) return json(res, error.status, { error: error.code });
      if (error instanceof ImportUploadError) return json(res, error.code === "upload-too-large" ? 413 : 422, { error: error.code });
      throw error;
    }
  };
}
