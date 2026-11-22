import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGE_DEFAULT_MODELS } from "../shared/image-generation.ts";
import { generateImage, imageGenerationReady, imageSlotConfigured, imageSlots, markupProblem, type ImageCredentials } from "./image-generation.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { codexAuthFile } from "./testing/codex-image-auth.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const BOTH = {
  imageGen: { key: "openai-secret", primary: { provider: "openai" as const }, fallback: { provider: "xai" as const } },
  xai: { key: "xai-secret" },
};

function imageResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });
}

function hostOf(call: Parameters<typeof fetch>): string {
  return new URL(String(call[0])).host;
}

describe("image slots", () => {
  it("reads an older single-provider config as the base with no backup", () => {
    expect(imageSlots({ imageGen: { provider: "custom", customModel: "local/image" } })).toEqual({
      primary: { provider: "custom", model: "local/image" }, fallback: null,
    });
    expect(imageSlots({})).toEqual({ primary: { provider: "openai", model: "gpt-image-2" }, fallback: null });
  });

  it("prefers the saved base over the older provider field and fills each provider's default model", () => {
    expect(imageSlots({ imageGen: { provider: "custom", primary: { provider: "xai" }, fallback: { provider: "openai", model: "gpt-image-1" } } })).toEqual({
      primary: { provider: "xai", model: "grok-imagine-image-2.0" },
      fallback: { provider: "openai", model: "gpt-image-1" },
    });
  });

  it("ignores a backup identical to the base", () => {
    expect(imageSlots({ imageGen: { primary: { provider: "xai" }, fallback: { provider: "xai" } } }).fallback).toBeNull();
  });
});

describe("complexity", () => {
  const sent = async (model: string, complexity?: "low" | "medium" | "high") => {
    const fetchMock = vi.fn(async () => imageResponse());
    const cfg = { imageGen: { key: "openai-secret", primary: { provider: "openai" as const, model }, ...(complexity && { complexity }) } };
    await generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock });
    return JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  };

  it("goes to GPT-Image-2.6 models when set", async () => {
    expect((await sent("gpt-image-2.6-sunburst", "low")).complexity).toBe("low");
    expect((await sent("gpt-image-2.6-flare", "medium")).complexity).toBe("medium");
  });

  it("is left out when unset, and never sent to other models", async () => {
    expect(await sent("gpt-image-2.6-flare")).not.toHaveProperty("complexity");
    expect(await sent("gpt-image-2", "low")).not.toHaveProperty("complexity");
  });
});

describe("animated GIF", () => {
  const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const gifResponse = () => new Response(JSON.stringify({ data: [{ b64_json: GIF.toString("base64") }] }), { status: 200 });
  const cfg = (model: string) => ({ imageGen: { key: "openai-secret", primary: { provider: "openai" as const, model } } });

  it("asks a GPT-Image-2.6 model for a gif with its frame settings and returns it", async () => {
    const fetchMock = vi.fn(async () => gifResponse());
    const image = await generateImage(cfg("gpt-image-2.6-flare"), { prompt: "owl", gif: { frames: 6, frameDurationMs: 100 } }, { fetchImpl: fetchMock });
    expect(image.mime).toBe("image/gif");
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ output_format: "gif", frame_count: 6, frame_duration_ms: 100 });
  });

  it("refuses other models before any request", async () => {
    const fetchMock = vi.fn(async () => gifResponse());
    await expect(generateImage(cfg("gpt-image-2"), { prompt: "owl", gif: {} }, { fetchImpl: fetchMock })).rejects.toThrow(/GPT-Image-2.6/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still rejects a gif nobody asked for", async () => {
    await expect(generateImage(cfg("gpt-image-2.6-flare"), { prompt: "owl" }, { fetchImpl: vi.fn(async () => gifResponse()) })).rejects.toThrow(/invalid or oversized/);
  });
});

describe("image edits", () => {
  const png = (width: number, height: number, colorType: number) => {
    const head = Buffer.alloc(26);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head);
    head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20); head[24] = 8; head[25] = colorType;
    return { bytes: head, mime: "image/png" };
  };
  const cfg = (model: string) => ({ imageGen: { key: "openai-secret", primary: { provider: "openai" as const, model } } });

  it("posts the image and the markup to /images/edits with no generated size", async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    const image = png(64, 64, 2), markup = png(64, 64, 6);
    await generateImage(cfg("gpt-image-2.6-sunburst"), { prompt: "remove the circled cup", edit: { image, markup } }, { fetchImpl: fetchMock });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(init.headers).not.toHaveProperty("content-type");
    expect(form.get("model")).toBe("gpt-image-2.6-sunburst");
    expect(form.get("prompt")).toBe("remove the circled cup");
    expect(Buffer.from(await (form.get("image") as Blob).arrayBuffer())).toEqual(image.bytes);
    expect((form.get("markup") as Blob).type).toBe("image/png");
    expect(Buffer.from(await (form.get("markup") as Blob).arrayBuffer())).toEqual(markup.bytes);
    expect(form.has("size")).toBe(false);
  });

  it("refuses models that are not GPT-Image-2.6 before any request", async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    await expect(generateImage(cfg("gpt-image-2"), { prompt: "x", edit: { image: png(8, 8, 2) } }, { fetchImpl: fetchMock })).rejects.toThrow(/GPT-Image-2.6/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a markup that cannot be used", () => {
    const image = png(64, 64, 2);
    expect(markupProblem(image, png(64, 64, 6))).toBeNull();
    expect(markupProblem(image, png(64, 64, 2))).toMatch(/transparent/);
    expect(markupProblem(image, png(32, 64, 6))).toMatch(/same size/);
    expect(markupProblem(image, { bytes: Buffer.from("not a png"), mime: "image/png" })).toMatch(/must be a PNG/);
  });
});

describe("provider requests", () => {
  it("sends a Gemini key only to Google's OpenAI-compatible image route", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, imageGen: { ...BOTH.imageGen, geminiKey: "gemini-secret", primary: { provider: "gemini" as const } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "gemini", model: "gemini-2.5-flash-image" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/images/generations");
    expect(init?.headers).toMatchObject({ authorization: "Bearer gemini-secret" });
    expect(JSON.stringify(init)).not.toMatch(/openai-secret|xai-secret/);
    expect(JSON.parse(String(init?.body))).toEqual({ model: "gemini-2.5-flash-image", prompt: "owl", response_format: "b64_json", size: "1024x1024", n: 1 });
  });

  it("reuses the OpenRouter key at OpenRouter's image endpoint with the chosen model and shape", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, openrouter: { key: "or-secret" }, imageGen: { ...BOTH.imageGen, primary: { provider: "openrouter" as const, model: "black-forest-labs/flux.2-pro" } } };
    await generateImage(cfg, { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(init?.headers).toMatchObject({ authorization: "Bearer or-secret" });
    expect(JSON.parse(String(init?.body))).toEqual({ model: "black-forest-labs/flux.2-pro", prompt: "owl", aspect_ratio: "16:9" });
  });

  it("maps a wide request to OpenAI's landscape size at the provider's normal quality", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await generateImage(BOTH, { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ size: "1536x1024", quality: "auto" });
  });

  it("accepts a Custom provider that sends url and revised_prompt as null next to the image", async () => {
    const body = { created: 1, data: [{ b64_json: PNG.toString("base64"), url: null, revised_prompt: null }] };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const cfg = { imageGen: { customUrl: "http://127.0.0.1:4711/v1/openai", customApiKey: "custom-secret", customModel: "vendor/image-model", primary: { provider: "custom" as const } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "custom", model: "vendor/image-model", bytes: PNG, mime: "image/png" });
  });

  it("still asks for inline image data when a provider sends only a url", async () => {
    const body = { data: [{ b64_json: null, url: "https://images.example/owl.png" }] };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(generateImage({ imageGen: { key: "openai-secret" } }, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("must return base64 image data (b64_json)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["gemini", "openrouter"] as const)("treats %s without its key as not set up, so the backup takes over", async (provider) => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, imageGen: { ...BOTH.imageGen, primary: { provider } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
  });
});

describe("generateImage with a backup", () => {
  it("uses only the base when it succeeds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({
      mime: "image/png", provider: "openai", model: "gpt-image-2", usedFallback: false,
    });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.openai.com"]);
  });

  it("moves to the backup when the base has no key, without calling the base", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, imageGen: { ...BOTH.imageGen, key: "" } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.x.ai"]);
  });

  it.each([401, 402, 403, 429])("moves to the backup when the base answers HTTP %s", async (status) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status }))
      .mockResolvedValueOnce(imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.openai.com", "api.x.ai"]);
  });

  it("moves to the backup when the base refuses with a body that breaks mid-stream", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("socket hang up")) });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(broken, { status: 429 }))
      .mockResolvedValueOnce(imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
  });

  it("moves to the backup when the base refuses the connection", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(refused).mockResolvedValueOnce(imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai" });
  });

  it.each([
    ["a server error, which may already have produced and billed an image", 500],
    ["a refused request, such as a moderation block", 400],
  ])("stays on the base after %s", async (_why, status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status }));
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow(`OpenAI image generation failed (HTTP ${status}, model gpt-image-2)`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stays on the base after a timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports the base's own error when there is no backup", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 429 }));
    await expect(generateImage({ imageGen: { key: "openai-secret" } }, { prompt: "owl" }, { fetchImpl: fetchMock }))
      .rejects.toThrow("OpenAI image generation failed (HTTP 429, model gpt-image-2)");
  });

  it("uses only the backup when the caller asks for it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { slot: "fallback", fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.x.ai"]);
  });

  it("says so when the caller asks for a backup that is not set", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(generateImage({ imageGen: { key: "k" } }, { prompt: "owl" }, { slot: "fallback", fetchImpl: fetchMock }))
      .rejects.toMatchObject({ status: 409, message: "No backup image provider is set" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what the person learns when a provider fails", () => {
  it("passes a wide Gemini request on as Google's landscape size", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { imageGen: { geminiKey: "gemini-secret", primary: { provider: "gemini" as const } } };
    await generateImage(cfg, { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ size: "1536x1024" });
  });

  it("names the model a provider refused, so a wrong model ID is visible", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 }));
    const cfg = { openrouter: { key: "or-secret" }, imageGen: { primary: { provider: "openrouter" as const, model: "google/not-a-model" } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("OpenRouter image generation failed (HTTP 404, model google/not-a-model)");
  });

  it("keeps the base's reason when the backup made the image", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => new URL(String(input)).host === "api.openai.com" ? new Response("{}", { status: 401 }) : imageResponse());
    const made = await generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock });
    expect(made).toMatchObject({ provider: "xai", usedFallback: true, baseError: "OpenAI image generation failed (HTTP 401, model gpt-image-2)" });
  });

  it("reports both reasons when the base and the backup fail", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => new Response("{}", { status: new URL(String(input)).host === "api.openai.com" ? 402 : 429 }));
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow(
      "xAI image generation failed (HTTP 429, model grok-imagine-image-2.0); the base first failed: OpenAI image generation failed (HTTP 402, model gpt-image-2)",
    );
  });

  it("stops the provider call when the caller cancels, and does not try the backup", async () => {
    const seen: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      seen.push(init!.signal!);
      init!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const cancel = new AbortController();
    const pending = generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock, signal: cancel.signal });
    cancel.abort();
    await expect(pending).rejects.toThrow("Image generation was cancelled");
    expect(seen[0]!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("brings back the last model typed for Custom when the base or the backup goes back to Custom", () => {
    expect(imageSlots({ imageGen: { customModel: "local/image", primary: { provider: "custom" } } }).primary).toEqual({ provider: "custom", model: "local/image" });
    expect(imageSlots({ imageGen: { customModel: "local/image", primary: { provider: "openai" }, fallback: { provider: "custom" } } }).fallback).toEqual({ provider: "custom", model: "local/image" });
    expect(imageSlots({ imageGen: { customModel: "local/image", primary: { provider: "custom", model: "other/image" } } }).primary.model).toBe("other/image");
  });

  it("never uses an API key that was saved as a model, so it is never sent or shown as one", () => {
    const gateway = { customUrl: "http://127.0.0.1:4000/v1", customApiKey: "my-private-gateway-key" };
    const pasted = imageSlots({ imageGen: { ...gateway, customModel: "my-private-gateway-key", primary: { provider: "custom" } } });
    expect(pasted.primary).toEqual({ provider: "custom", model: "" });
    expect(imageGenerationReady({ imageGen: { ...gateway, customModel: "my-private-gateway-key", primary: { provider: "custom" } } })).toBe(false);
    expect(imageSlots({ imageGen: { ...gateway, primary: { provider: "custom", model: "sk-proj-abcdefghijklmnop" } } }).primary.model).toBe("");
    expect(imageSlots({ openrouter: { key: "or-key" }, imageGen: { primary: { provider: "openrouter", model: "or-key" } } }).primary.model).toBe(IMAGE_DEFAULT_MODELS.openrouter);
  });
});

describe("a Custom gateway that accepts only size auto", () => {
  const CUSTOM = { imageGen: { customUrl: "http://127.0.0.1:4711/v1", customApiKey: "custom-secret", customModel: "vendor/image-model", primary: { provider: "custom" as const } } };
  const sizes = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) => fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).size);

  it("retries once with size auto when the exact size fails, and makes the image", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => JSON.parse(String(init?.body)).size === "auto" ? imageResponse() : new Response("{}", { status: 502 }));
    await expect(generateImage(CUSTOM, { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "custom", bytes: PNG });
    expect(sizes(fetchMock)).toEqual(["1536x1024", "auto"]);
  });

  it("tries auto only once and reports the exact size's failure", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 400 }));
    await expect(generateImage(CUSTOM, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("Custom image generation failed (HTTP 400, model vendor/image-model)");
    expect(sizes(fetchMock)).toEqual(["1024x1024", "auto"]);
  });

  it("keeps the exact size's error when the auto retry cannot connect", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (JSON.parse(String(init?.body)).size === "auto") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return new Response("{}", { status: 502 });
    });
    await expect(generateImage(CUSTOM, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("Custom image generation failed (HTTP 502, model vendor/image-model)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 402, 403, 429])("does not retry when the gateway refuses the key or quota (HTTP %i)", async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status }));
    await expect(generateImage(CUSTOM, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the exact size when it works", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await generateImage(CUSTOM, { prompt: "owl", aspect: "9:16" }, { fetchImpl: fetchMock });
    expect(sizes(fetchMock)).toEqual(["1024x1536"]);
  });

  it("never retries other providers with size auto", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 502 }));
    await expect(generateImage({ imageGen: { key: "openai-secret" } }, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("HTTP 502");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("OpenAI images and the main OpenAI key", () => {
  const bearer = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) => new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get("authorization");

  it("uses the main OpenAI key when no image key of its own is saved", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { openai: { key: "main-openai-key" }, imageGen: { primary: { provider: "openai" as const } } };
    expect(imageGenerationReady(cfg)).toBe(true);
    await generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock });
    expect(bearer(fetchMock)).toBe("Bearer main-openai-key");
  });

  it("keeps the image key of its own when both are saved", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await generateImage({ openai: { key: "main-openai-key" }, imageGen: { key: "image-openai-key" } }, { prompt: "owl" }, { fetchImpl: fetchMock });
    expect(bearer(fetchMock)).toBe("Bearer image-openai-key");
  });

  it("never takes the main OpenAI key as a model ID", () => {
    expect(imageSlots({ openai: { key: "main-openai-key" }, imageGen: { primary: { provider: "openai", model: "main-openai-key" } } }).primary.model).toBe("gpt-image-2");
  });
});

describe("Codex images with Codex's own ChatGPT sign-in", () => {
  const URL_CODEX = "https://chatgpt.com/backend-api/codex/images/generations";
  let home: string;
  const codexDir = () => join(home, "codex-home");
  const cfg = (extra: Partial<ImageCredentials> = {}): ImageCredentials => ({
    instances: { codex: { driver: "codex", environment: { CODEX_HOME: codexDir() } } },
    imageGen: { primary: { provider: "codex" } },
    ...extra,
  });
  const sign = (token: string, plan: string | null = "plus", expiresAt = Date.now() + 3_600_000) =>
    codexAuthFile(codexDir(), { token, accountId: "acct-fixture", plan, expiresAt });
  const call = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) => {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
    return { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seira-codex-images-"));
    mkdirSync(codexDir());
  });
  afterEach(async () => { await removeTempDir(home); });

  it("sends one request to the Codex Images endpoint with the sign-in's token and account id, and returns the image", async () => {
    const access = sign("token-one");
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const renew = vi.fn(async () => true);
    const image = await generateImage(cfg(), { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock, renewCodex: renew });
    expect(image).toMatchObject({ provider: "codex", model: "gpt-image-2", mime: "image/png", usedFallback: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = call(fetchMock);
    expect(sent.url).toBe(URL_CODEX);
    expect(sent.headers.get("authorization")).toBe(`Bearer ${access}`);
    expect(sent.headers.get("chatgpt-account-id")).toBe("acct-fixture");
    expect(sent.body).toEqual({ model: "gpt-image-2", prompt: "owl", size: "1536x1024", quality: "auto", output_format: "png", background: "auto", n: 1 });
    expect(renew).not.toHaveBeenCalled();
  });

  it("never sends a detail level to Codex", async () => {
    sign("token-one");
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await generateImage(cfg({ imageGen: { primary: { provider: "codex", model: "gpt-image-2.6-flare" }, complexity: "low" } }), { prompt: "owl" }, { fetchImpl: fetchMock });
    expect(call(fetchMock).body).not.toHaveProperty("complexity");
  });

  it("counts as not set up without a sign-in, and moves to the backup without calling Codex", async () => {
    expect(imageGenerationReady(cfg())).toBe(false);
    expect(imageSlotConfigured(cfg(), { provider: "codex", model: "gpt-image-2" })).toBe(false);
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await expect(generateImage(cfg(), { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("Sign in to Codex with a ChatGPT plan first");
    expect(fetchMock).not.toHaveBeenCalled();
    const withBackup = cfg({ imageGen: { primary: { provider: "codex" }, fallback: { provider: "xai" } }, xai: { key: "xai-secret" } });
    expect(await generateImage(withBackup, { prompt: "owl" }, { fetchImpl: fetchMock })).toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.x.ai"]);
  });

  it("refuses the free plan before any request, and tries the backup", async () => {
    sign("token-free", "free");
    expect(imageGenerationReady(cfg())).toBe(false);
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await expect(generateImage(cfg(), { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("Codex makes images only on a paid ChatGPT plan");
    expect(fetchMock).not.toHaveBeenCalled();
    const withBackup = cfg({ imageGen: { primary: { provider: "codex" }, fallback: { provider: "xai" } }, xai: { key: "xai-secret" } });
    expect(await generateImage(withBackup, { prompt: "owl" }, { fetchImpl: fetchMock })).toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.x.ai"]);
  });

  it("asks Codex to renew once after a 401, and retries once with the new token", async () => {
    const oldToken = sign("token-old");
    let newToken = "";
    const renew = vi.fn(async () => { newToken = sign("token-new"); return true; });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(imageResponse());
    expect(await generateImage(cfg(), { prompt: "owl" }, { fetchImpl: fetchMock, renewCodex: renew })).toMatchObject({ provider: "codex" });
    expect(renew).toHaveBeenCalledOnce();
    expect(call(fetchMock, 0).headers.get("authorization")).toBe(`Bearer ${oldToken}`);
    expect(call(fetchMock, 1).headers.get("authorization")).toBe(`Bearer ${newToken}`);
  });

  it("stops after one renewal, says nothing of the token, and lets the backup try", async () => {
    const access = sign("token-refused");
    const renew = vi.fn(async () => true);
    const fetchMock = vi.fn<typeof fetch>(async (url) => String(url).startsWith(URL_CODEX) ? new Response("{}", { status: 401 }) : imageResponse());
    const error = await generateImage(cfg(), { prompt: "owl" }, { fetchImpl: fetchMock, renewCodex: renew }).catch((cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Codex image generation failed (HTTP 401, model gpt-image-2)");
    expect((error as Error).message).not.toContain(access);
    expect(renew).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const withBackup = cfg({ imageGen: { primary: { provider: "codex" }, fallback: { provider: "xai" } }, xai: { key: "xai-secret" } });
    expect(await generateImage(withBackup, { prompt: "owl" }, { fetchImpl: fetchMock, renewCodex: renew })).toMatchObject({ provider: "xai", usedFallback: true });
  });

  it("renews a token that has already ended before the first request", async () => {
    sign("token-ended", "plus", Date.now() - 1_000);
    let newToken = "";
    const renew = vi.fn(async () => { newToken = sign("token-fresh"); return true; });
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await generateImage(cfg(), { prompt: "owl" }, { fetchImpl: fetchMock, renewCodex: renew });
    expect(renew).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(call(fetchMock).headers.get("authorization")).toBe(`Bearer ${newToken}`);
  });

  it("retries once with size auto when Codex refuses the exact size", async () => {
    sign("token-one");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(imageResponse());
    await generateImage(cfg(), { prompt: "owl" }, { fetchImpl: fetchMock });
    expect([call(fetchMock, 0).body.size, call(fetchMock, 1).body.size]).toEqual(["1024x1024", "auto"]);
  });

  it.each([402, 403, 429])("does not retry size auto after HTTP %i", async (status) => {
    sign("token-one");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status }));
    await expect(generateImage(cfg(), { prompt: "owl" }, { fetchImpl: fetchMock, renewCodex: async () => true })).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("leaves animated GIFs and edits to OpenAI's GPT-Image-2.6", async () => {
    sign("token-one");
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const flare = cfg({ imageGen: { primary: { provider: "codex", model: "gpt-image-2.6-flare" } } });
    await expect(generateImage(flare, { prompt: "owl", gif: {} }, { fetchImpl: fetchMock })).rejects.toThrow("Animated GIFs need");
    await expect(generateImage(flare, { prompt: "owl", edit: { image: { bytes: PNG, mime: "image/png" } } }, { fetchImpl: fetchMock })).rejects.toThrow("Editing an image needs");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
