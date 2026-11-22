// The answer is a verdict, never the key and never the vendor's body; nothing here makes an image.
import { z } from "zod";

import { IMAGE_MODEL_CHOICES, IMAGE_PROVIDERS, type ImageProvider, type ImageProviderTest } from "../../shared/image-generation.ts";
import { avatarGenerationRequestSchema, generateAvatarImage } from "../avatar-image.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { codexImageLogin, codexPlanMakesImages, renewCodexImageLogin } from "../codex-image-login.ts";
import { createOpenRouterModelCatalog } from "../decider/openrouter-models.ts";
import { customImageUrl, imageProviderKey, imageSlots, type ImageCredentials, type RenewCodexLogin } from "../image-generation.ts";
import { checkProviderKey, type ProviderKeyKind } from "../provider-key-check.ts";
import { PASS, type RouteHandler } from "./table.ts";

const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
/** Codex's plan-usage answer: it checks the ChatGPT sign-in without making an image. */
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const testSchema = z.object({ provider: z.enum(IMAGE_PROVIDERS) });

/** Every openaiCompat target carries its own URL: without one, the key check would fall back to OpenRouter. */
function keyCheckTarget(cfg: ImageCredentials, provider: Exclude<ImageProvider, "codex">): { provider: ProviderKeyKind; url?: string } | null {
  if (provider === "gemini") return { provider: "openaiCompat", url: GEMINI_OPENAI_BASE };
  if (provider === "custom") {
    const url = customImageUrl(cfg);
    return url ? { provider: "openaiCompat", url } : null;
  }
  return { provider };
}

/** OpenRouter answers 404 for a model ID it does not have; its catalog needs no key. */
async function openrouterHasModel(model: string, fetchImpl: typeof fetch): Promise<boolean | null> {
  const [vendor, ...slug] = model.split("/");
  if (!vendor || slug.length === 0) return false;
  const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(vendor)}/${slug.map(encodeURIComponent).join("/")}/endpoints`;
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 404 ? false : response.ok ? true : null;
  } catch {
    return null;
  }
}

/** Checks Codex's own ChatGPT sign-in; the answer names no token, account id or email. */
async function testCodexSignIn(cfg: ImageCredentials, fetchImpl: typeof fetch, renewCodex: RenewCodexLogin): Promise<ImageProviderTest> {
  let codex = codexImageLogin(cfg.instances);
  if (!codex) return { ok: false, reason: "no_sign_in" };
  if (!codexPlanMakesImages(codex.login.plan)) return { ok: false, reason: "free_plan" };
  const check = async (): Promise<number | null> => {
    if (!codex) return null;
    try {
      const response = await fetchImpl(CODEX_USAGE_URL, {
        headers: { authorization: `Bearer ${codex.login.token}`, "chatgpt-account-id": codex.login.accountId, accept: "application/json" },
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    } catch {
      return null;
    }
  };
  let status = codex.login.expired ? 401 : await check();
  if (status === 401 || status === 403) {
    await renewCodex(codex.source).catch(() => false);
    codex = codexImageLogin(cfg.instances);
    if (!codex) return { ok: false, reason: "no_sign_in" };
    status = await check();
  }
  if (status === null) return { ok: false, reason: "unreachable" };
  if (status >= 200 && status < 300) return { ok: true, check: "authentication" };
  if (status === 401 || status === 403) return { ok: false, reason: "rejected", status };
  return { ok: false, reason: "unexpected", status };
}

export async function testImageProvider(
  cfg: ImageCredentials,
  provider: ImageProvider,
  fetchImpl: typeof fetch = fetch,
  renewCodex: RenewCodexLogin = renewCodexImageLogin,
): Promise<ImageProviderTest> {
  if (provider === "codex") return testCodexSignIn(cfg, fetchImpl, renewCodex);
  const target = keyCheckTarget(cfg, provider);
  if (!target) return { ok: false, reason: "no_url" };
  const key = imageProviderKey(cfg, provider);
  if (!key) return { ok: false, reason: "no_key" };
  const verdict = await checkProviderKey({ ...target, key }, fetchImpl);
  if (!verdict.ok) return verdict;
  if (provider === "openrouter") {
    const { primary, fallback } = imageSlots(cfg);
    for (const slot of [primary, fallback]) {
      if (slot?.provider !== provider) continue;
      const found = await openrouterHasModel(slot.model, fetchImpl);
      if (found === false) return { ok: false, reason: "model_missing", model: slot.model };
      // A 5xx, a timeout or no network leaves the model unchecked: never answer that it is there.
      if (found === null) return { ok: false, reason: "unreachable" };
    }
  }
  return { ok: true, check: verdict.check, ...(verdict.freeTier !== undefined ? { freeTier: verdict.freeTier } : {}) };
}

export function createImageSettingsRoutes(deps: { config: () => ImageCredentials; fetch?: typeof fetch; renewCodex?: RenewCodexLogin }): RouteHandler {
  const models = createOpenRouterModelCatalog({ fetch: deps.fetch, output: "image", curated: IMAGE_MODEL_CHOICES.openrouter });
  return async ({ req, res, path, method, json, readBody }) => {
    if (method === "POST" && path === "/api/bot-defaults/avatar") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "avatar preview must be a JSON object" });
      const profile = parseBotProfilePatch(body.profile, true);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      const checked = avatarGenerationRequestSchema.safeParse({ prompt: body.prompt });
      if (!checked.success) return json(res, 400, { error: checked.error.message });
      const generated = await generateAvatarImage(deps.config(), {
        name: profile.patch.name ?? "", title: profile.patch.title ?? "", description: profile.patch.description ?? "",
      }, checked.data.prompt, deps.fetch);
      return json(res, 200, { dataUrl: `data:${generated.mime};base64,${generated.bytes.toString("base64")}` });
    }
    if (path === "/api/images/openrouter-models" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, await models.load());
    }
    if (path !== "/api/images/test" || method !== "POST") return PASS;
    const parsed = testSchema.safeParse(await readBody(req, 8192));
    if (!parsed.success) return json(res, 400, { error: `provider must be one of ${IMAGE_PROVIDERS.join(", ")}` });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, await testImageProvider(deps.config(), parsed.data.provider, deps.fetch, deps.renewCodex));
  };
}
