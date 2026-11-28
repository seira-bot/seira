import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, SmallModelFallback, TextGenerationUsage } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { QuickModelFallback } from "../quick-model-fallback.ts";
import { createSideJobs } from "../side-jobs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDriver } from "./codex.ts";
import {
  CODEX_BACKGROUND_EFFORT,
  CODEX_BACKGROUND_TIMEOUT_MS,
  codexBackgroundArgs,
  codexBackgroundModel,
  codexBackgroundProviderArgs,
  codexBackgroundRoute,
  runCodexBackgroundRoute,
  runCodexOneShot,
} from "./codex-background-text.ts";

vi.mock("./codex-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-release.ts")>(),
  readLatestCodexRelease: async () => null,
}));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

interface ExecCall { argv: string[]; cwd: string; prompt: string; env: Record<string, string> }

describe("codexBackgroundModel", () => {
  const row = (id: string, custom = false) => ({ id, label: id, ...(custom ? { custom } : {}) });

  it("picks the smallest model the account lists, in the documented order", () => {
    expect(codexBackgroundModel({ default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-5.6-luna"), row("gpt-6-luna")] })).toBe("gpt-6-luna");
    expect(codexBackgroundModel({ default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-5.4-mini"), row("gpt-5.6-luna")] })).toBe("gpt-5.6-luna");
    expect(codexBackgroundModel({ default: "gpt-7-sol", options: [row("gpt-7-sol"), row("gpt-7-luna")] })).toBe("gpt-7-luna");
  });

  it("never picks a model from the person's own providers, and falls back to the default", () => {
    expect(codexBackgroundModel({ default: "gpt-6-astra", options: [row("gpt-6-astra"), row("omlx::gpt-6-luna", true), row("omlx::tiny-mini", true)] })).toBe("gpt-6-astra");
    expect(codexBackgroundModel({ default: "company-large", options: [row("company-large"), row("company-small")] })).toBe("company-large");
    expect(codexBackgroundModel({ default: "", options: [] })).toBeNull();
  });

  it("never picks a small model this instance refused before", () => {
    const catalog = { default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-6-luna"), row("gpt-5.6-luna"), row("gpt-5.4-mini")] };
    expect(codexBackgroundModel(catalog, new Set(["gpt-6-luna"]))).toBe("gpt-5.6-luna");
    expect(codexBackgroundModel(catalog, new Set(["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"]))).toBe("gpt-6-astra");
  });
});

describe("codexBackgroundRoute", () => {
  const row = (id: string) => ({ id, label: id });
  const catalog = { default: "gpt-6-astra", options: [row("gpt-6-astra"), row("gpt-6-sol"), row("gpt-5.4-mini")] };
  const fallback = (model?: string, refused: string[] = []): SmallModelFallback => ({ ...(model ? { model } : {}), refused: new Set(refused), onRefused: () => {} });

  it("writes on the bot's own model, or the account's default, for a sign-in that cannot use small models", () => {
    expect(codexBackgroundRoute(catalog, false, fallback("gpt-6-sol"))).toEqual({ model: "gpt-6-sol" });
    expect(codexBackgroundRoute(catalog, false)).toEqual({ model: "gpt-6-astra" });
    expect(codexBackgroundRoute({ default: "", options: [] }, false)).toBeNull();
  });

  it("keeps the small model otherwise, with the bot's own model to run once more on", () => {
    expect(codexBackgroundRoute(catalog, true, fallback("gpt-6-sol"))).toEqual({ model: "gpt-5.4-mini", retry: "gpt-6-sol" });
    expect(codexBackgroundRoute(catalog, true)).toEqual({ model: "gpt-5.4-mini", retry: "gpt-6-astra" });
    expect(codexBackgroundRoute(catalog, true, fallback("gpt-6-sol", ["gpt-5.4-mini"]))).toEqual({ model: "gpt-6-astra", retry: "gpt-6-sol" });
    expect(codexBackgroundRoute(catalog, true, fallback("gpt-6-astra", ["gpt-5.4-mini"]))).toEqual({ model: "gpt-6-astra" });
  });

  it("stays on the provider the bot's own model runs on, never OpenAI's small models", () => {
    const gateway = { default: "gpt-6-astra", options: [...catalog.options, { id: "mygw::glm-5", label: "GLM 5", custom: true }] };
    expect(codexBackgroundRoute(gateway, true, fallback("mygw::glm-5"))).toEqual({ model: "mygw::glm-5" });
    expect(codexBackgroundRoute(gateway, false, fallback("mygw::glm-5"))).toEqual({ model: "mygw::glm-5" });
    expect(codexBackgroundRoute({ ...gateway, default: "mygw::glm-5" }, true)).toEqual({ model: "mygw::glm-5" });
    const withSmall = { ...gateway, options: [...gateway.options, { id: "mygw::glm-5-mini", label: "GLM 5 mini", custom: true }] };
    expect(codexBackgroundRoute(withSmall, true, fallback("mygw::glm-5"))).toEqual({ model: "mygw::glm-5-mini", retry: "mygw::glm-5" });
    expect(codexBackgroundRoute(withSmall, true, fallback("mygw::glm-5", ["mygw::glm-5-mini"]))).toEqual({ model: "mygw::glm-5" });
  });

  it("goes straight to the bot's own model once OpenAI turned a background call away", () => {
    expect(codexBackgroundRoute(catalog, true, fallback("gpt-6-sol"), true)).toEqual({ model: "gpt-6-sol" });
    expect(codexBackgroundRoute(catalog, true, undefined, true)).toEqual({ model: "gpt-6-astra" });
  });
});

describe("runCodexBackgroundRoute", () => {
  const blocked = 'unexpected status 403 Forbidden: {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}';
  const failOn = (failing: string, message: string) => {
    const ran: string[] = [];
    return { ran, run: async (model: string) => { ran.push(model); if (model === failing) throw new Error(message); return `from ${model}`; } };
  };

  it("runs once more on the bot's own model when OpenAI blocks or cannot be reached, and says so", async () => {
    for (const message of [blocked, "Codex background call timed out: Reconnecting... waiting for network (Connection failed: error sending request)"]) {
      const { ran, run } = failOn("gpt-5.4-mini", message);
      const onRefused = vi.fn();
      const unreachable = vi.fn();
      await expect(runCodexBackgroundRoute({ model: "gpt-5.4-mini", retry: "mygw::glm-5" }, run, { fallback: { refused: new Set(), onRefused } }, unreachable)).resolves.toBe("from mygw::glm-5");
      expect(ran).toEqual(["gpt-5.4-mini", "mygw::glm-5"]);
      expect(unreachable).toHaveBeenCalledOnce();
      expect(onRefused).not.toHaveBeenCalled();
    }
  });

  it("fails as before off OpenAI, without a listener, or for another error", async () => {
    const unreachable = vi.fn();
    const own = failOn("mygw::glm-5-mini", blocked);
    await expect(runCodexBackgroundRoute({ model: "mygw::glm-5-mini", retry: "mygw::glm-5" }, own.run, {}, unreachable)).rejects.toThrow(/403/);
    const managed = failOn("gpt-6-luna", blocked);
    await expect(runCodexBackgroundRoute({ model: "gpt-6-luna", retry: "company-large" }, managed.run)).rejects.toThrow(/403/);
    const signedOut = failOn("gpt-6-luna", "unexpected status 401 Unauthorized");
    await expect(runCodexBackgroundRoute({ model: "gpt-6-luna", retry: "gpt-6-sol" }, signedOut.run, {}, unreachable)).rejects.toThrow(/401/);
    expect([own.ran, managed.ran, signedOut.ran]).toEqual([["mygw::glm-5-mini"], ["gpt-6-luna"], ["gpt-6-luna"]]);
    expect(unreachable).not.toHaveBeenCalled();
  });
});

describe("codexBackgroundProviderArgs", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seira-codex-provider-test-")); });
  afterEach(async () => { await removeTempDir(home); });

  const argsFor = (toml: string, model = "mygw::glm-5", file = "config.toml") => {
    writeFileSync(join(home, file), toml);
    const env: Record<string, string | undefined> = { CODEX_HOME: home };
    const args = codexBackgroundProviderArgs(env, model);
    return { env, args, overrides: args.filter((_, index) => args[index - 1] === "-c") };
  };

  it("carries the person's config.toml provider, its token and headers in the environment only", () => {
    const { env, args, overrides } = argsFor([
      'model = "glm-5"', 'model_provider = "mygw"', "",
      "[model_providers.other]", 'base_url = "https://other.example/v1"', "",
      "[model_providers.mygw]", 'name = "My gateway" # mine', 'base_url = "https://gw.example/v1"', 'wire_api = "responses"',
      'experimental_bearer_token = "sk-gateway-secret"', "request_max_retries = 2", "", "[model_providers.mygw.query_params]", 'api-version = "2026-01-01"', "",
      "[model_providers.mygw.http_headers]", '"X-Team" = "team-secret"', "",
      "[mcp_servers.mine]", 'command = "mine-mcp"',
    ].join("\n"));
    expect(overrides).toEqual([
      'model_providers.mygw.name="My gateway"',
      'model_providers.mygw.base_url="https://gw.example/v1"',
      'model_providers.mygw.wire_api="responses"',
      "model_providers.mygw.request_max_retries=2",
      'model_providers.mygw.query_params.api-version="2026-01-01"',
      'model_providers.mygw.env_http_headers.X-Team="SEIRA_CODEX_MYGW_HEADER_1"',
      'model_providers.mygw.env_key="SEIRA_CODEX_MYGW_TOKEN"',
    ]);
    expect(args.join(" ")).not.toMatch(/secret|other\.example|mine-mcp/);
    expect(env.SEIRA_CODEX_MYGW_TOKEN).toBe("sk-gateway-secret");
    expect(env.SEIRA_CODEX_MYGW_HEADER_1).toBe("team-secret");
  });

  it("reads inline and dotted provider tables, and a profile file's", () => {
    expect(argsFor('[model_providers]\nmygw = { name = "GW", base_url = "https://gw.example/v1" }\n').overrides)
      .toEqual(['model_providers.mygw.name="GW"', 'model_providers.mygw.base_url="https://gw.example/v1"']);
    expect(argsFor('model_providers.mygw.base_url = "https://gw.example/v1"\nmodel_providers.mygw.env_key = "GW_KEY"\n').overrides)
      .toEqual(['model_providers.mygw.base_url="https://gw.example/v1"', 'model_providers.mygw.env_key="GW_KEY"']);
    writeFileSync(join(home, "config.toml"), 'model_provider = "mygw"\n');
    expect(argsFor('[model_providers.mygw]\nbase_url = "https://work.example/v1"\n', "mygw::glm-5", "work.config.toml").overrides)
      .toEqual(['model_providers.mygw.base_url="https://work.example/v1"']);
  });

  it("moves a header and a token out of argv when they sit in an inline table", () => {
    const { env, args, overrides } = argsFor([
      "[model_providers.mygw]", 'base_url = "https://gw.example/v1"',
      'http_headers = { Authorization = "Bearer synthetic-inline-header", "X-Team" = \'synthetic-inline-team\' }',
    ].join("\n"));
    expect(overrides).toEqual([
      'model_providers.mygw.base_url="https://gw.example/v1"',
      'model_providers.mygw.env_http_headers.Authorization="SEIRA_CODEX_MYGW_HEADER_1"',
      'model_providers.mygw.env_http_headers.X-Team="SEIRA_CODEX_MYGW_HEADER_2"',
    ]);
    expect(args.join(" ")).not.toMatch(/synthetic/);
    expect(env.SEIRA_CODEX_MYGW_HEADER_1).toBe("Bearer synthetic-inline-header");
    expect(env.SEIRA_CODEX_MYGW_HEADER_2).toBe("synthetic-inline-team");
  });

  it("moves a token and nested headers out of argv when the provider itself is an inline table", () => {
    for (const toml of [
      '[model_providers]\nmygw = { base_url = "https://gw.example/v1", experimental_bearer_token = "synthetic-inline-token", http_headers = { "X-Team" = "synthetic-nested-team" } }\n',
      'model_providers.mygw = { base_url = "https://gw.example/v1", experimental_bearer_token = "synthetic-inline-token", http_headers = { "X-Team" = "synthetic-nested-team" } }\n',
    ]) {
      const { env, args, overrides } = argsFor(toml);
      expect(overrides).toEqual([
        'model_providers.mygw.base_url="https://gw.example/v1"',
        'model_providers.mygw.env_http_headers.X-Team="SEIRA_CODEX_MYGW_HEADER_1"',
        'model_providers.mygw.env_key="SEIRA_CODEX_MYGW_TOKEN"',
      ]);
      expect(args.join(" ")).not.toMatch(/synthetic/);
      expect(env.SEIRA_CODEX_MYGW_TOKEN).toBe("synthetic-inline-token");
      expect(env.SEIRA_CODEX_MYGW_HEADER_1).toBe("synthetic-nested-team");
    }
  });

  it("adds nothing from a file that does not parse, and reads the next file instead", () => {
    const broken = [
      'mygw = { base_url = "https://gw.example/v1" experimental_bearer_token = "synthetic-broken-1" }',
      'mygw = { base_url = "https://gw.example/v1", experimental_bearer_token = "synthetic-broken-2" } }',
      'mygw = { base_url = "https://gw.example/v1", = "synthetic-broken-3" }',
      'mygw = { base_url = "https://gw.example/v1", http_headers = { A = "synthetic-broken-5" b = "x" } }',
      'mygw = { base_url = "https://gw.example/v1", experimental_bearer_token = "synthetic-broken-6',
      'mygw = { base_url = "https://gw.example/v1", experimental_bearer_token = "synthetic-broken-7" }\nmygw = {}',
    ];
    for (const line of broken) {
      const { env, args } = argsFor(`[model_providers]\n${line}\n`);
      expect(args, line).toEqual([]);
      expect(Object.keys(env)).toEqual(["CODEX_HOME"]);
    }
    // A bad broken line next to good keys of the same file drops the whole file: nothing is half-read.
    const mixed = argsFor('[model_providers.mygw]\nbase_url = "https://gw.example/v1"\nhttp_headers = { A = "synthetic-broken-8" b = "x" }\n');
    expect(mixed.args).toEqual([]);
    // A profile file that parses is still read after a config.toml that does not.
    writeFileSync(join(home, "config.toml"), '[model_providers.mygw\nbase_url = "https://broken.example/v1"\n');
    const profile = argsFor('[model_providers.mygw]\nbase_url = "https://work.example/v1"\n', "mygw::glm-5", "work.config.toml");
    expect(profile.overrides).toEqual(['model_providers.mygw.base_url="https://work.example/v1"']);
  });

  it("reads an inline table with a trailing comma, which TOML 1.1 allows, with the token in the environment", () => {
    const { env, args } = argsFor('[model_providers]\nmygw = { base_url = "https://gw.example/v1", experimental_bearer_token = "synthetic-trailing", }\n');
    expect(args).toEqual(["-c", 'model_providers.mygw.base_url="https://gw.example/v1"', "-c", 'model_providers.mygw.env_key="SEIRA_CODEX_MYGW_TOKEN"']);
    expect(env.SEIRA_CODEX_MYGW_TOKEN).toBe("synthetic-trailing");
  });

  it("reads quoted keys, escapes and literal strings by their value, and writes each value again as a fresh string", () => {
    const { env, overrides } = argsFor([
      "[model_providers.mygw]",
      '"name" = "Gat\\u00e9 \\"one\\" X"',
      "base_url = 'https://gw.example/v1'",
      '"wire_api" = "resp\\u006fnses"',
      "[model_providers.mygw.http_headers]",
      '"X-Team" = "line1\\nline2"',
      "'X-Lit' = 'C:\\path\\to'",
      '"X-D\\u0045L" = "del\\u007fvalue"',
      "[model_providers.mygw.query_params]",
      '"api-version" = "v\\u0031"',
    ].join("\n"));
    expect(overrides).toEqual([
      'model_providers.mygw.name="Gaté \\"one\\" X"',
      'model_providers.mygw.base_url="https://gw.example/v1"',
      'model_providers.mygw.wire_api="responses"',
      'model_providers.mygw.env_http_headers.X-Team="SEIRA_CODEX_MYGW_HEADER_1"',
      'model_providers.mygw.env_http_headers.X-Lit="SEIRA_CODEX_MYGW_HEADER_2"',
      'model_providers.mygw.env_http_headers.X-DEL="SEIRA_CODEX_MYGW_HEADER_3"',
      'model_providers.mygw.query_params.api-version="v1"',
    ]);
    expect(env.SEIRA_CODEX_MYGW_HEADER_1).toBe("line1\nline2");
    expect(env.SEIRA_CODEX_MYGW_HEADER_2).toBe("C:\\path\\to");
    expect(env.SEIRA_CODEX_MYGW_HEADER_3).toBe("del\u007fvalue");
  });

  it("forwards a field of the allowed list only with its own type, and nothing else", () => {
    const { env, args, overrides } = argsFor([
      "[model_providers.mygw]",
      "name = 5", "wire_api = { x = 'synthetic-wire' }", "env_key_instructions = true",
      'requires_openai_auth = "true"', 'request_max_retries = "2"', "stream_max_retries = -1", "stream_idle_timeout_ms = 1.5", "experimental_bearer_token = 12345",
      'unknown_field = "synthetic-unknown"', 'command = "synthetic-command"', "auth = { command = 'synthetic-auth' }", "supports_websockets = true",
      "[model_providers.mygw.aws]", 'profile = "synthetic-aws"',
    ].join("\n"));
    expect(overrides).toEqual([]);
    expect(args).toEqual([]);
    expect(Object.keys(env)).toEqual(["CODEX_HOME"]);
    const typed = argsFor([
      "[model_providers.mygw]",
      'name = "ok"', "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 5", "stream_idle_timeout_ms = 300000", 'env_key = "GW_KEY"', 'env_key_instructions = "export GW_KEY"',
      'unknown_field = "synthetic-unknown"',
    ].join("\n"));
    expect(typed.overrides).toEqual([
      'model_providers.mygw.name="ok"',
      "model_providers.mygw.requires_openai_auth=false",
      "model_providers.mygw.request_max_retries=0",
      "model_providers.mygw.stream_max_retries=5",
      "model_providers.mygw.stream_idle_timeout_ms=300000",
      'model_providers.mygw.env_key="GW_KEY"',
      'model_providers.mygw.env_key_instructions="export GW_KEY"',
    ]);
  });

  it("keeps only string entries of a header or query table, arrays and nested tables out", () => {
    const { env, args, overrides } = argsFor([
      "[model_providers.mygw]",
      "http_headers = { A = 'synthetic-a', B = 5, C = [ 'synthetic-c' ], D = { e = 'synthetic-d' }, 'bad key' = 'synthetic-e', 'x.y' = 'synthetic-f' }",
      "env_http_headers = { 'X-Env' = 'GW_ENV', 'X-Bad' = 'not a name', 'X-Num' = 5 }",
      "query_params = { 'api-version' = '1', api_key = 'synthetic-q1', 'x-token' = 'synthetic-q2', sig = 'synthetic-q3', n = 7, list = [ 'synthetic-q4' ] }",
    ].join("\n"));
    expect(overrides).toEqual([
      'model_providers.mygw.env_http_headers.A="SEIRA_CODEX_MYGW_HEADER_1"',
      'model_providers.mygw.env_http_headers.X-Env="GW_ENV"',
      'model_providers.mygw.query_params.api-version="1"',
    ]);
    expect(env.SEIRA_CODEX_MYGW_HEADER_1).toBe("synthetic-a");
    expect(args.join(" ")).not.toMatch(/synthetic/);
    // A header and a token never reach argv by any of the spellings of the table that holds them.
    for (const toml of [
      "[model_providers.mygw.http_headers]\nA = 'synthetic-h'\n",
      "model_providers.mygw.http_headers.A = 'synthetic-h'\n",
      "[model_providers]\nmygw.http_headers = { A = 'synthetic-h' }\n",
      "[model_providers.mygw]\nhttp_headers = {\"A\" = 'synthetic-h'}\n",
    ]) {
      const row = argsFor(toml);
      expect(row.overrides, toml).toEqual(['model_providers.mygw.env_http_headers.A="SEIRA_CODEX_MYGW_HEADER_1"']);
      expect(row.env.SEIRA_CODEX_MYGW_HEADER_1).toBe("synthetic-h");
    }
  });

  it("never forwards the text of the file: a comment, a trailing table or an odd key adds nothing", () => {
    const { args } = argsFor([
      "[model_providers.mygw] # model_providers.mygw.experimental_bearer_token = 'synthetic-comment'",
      'name = "a" # b = "synthetic-trailing"',
      'wire_api = "responses"',
      'env_key_instructions = "Set it\\" -c model_providers.mygw.experimental_bearer_token=\\"synthetic-inject"',
      "[model_providers.mygw.\"odd.key\"]", 'x = "synthetic-odd"',
      "[[model_providers.mygw.list]]", 'x = "synthetic-list"',
    ].join("\n"));
    expect(args).toEqual([
      "-c", 'model_providers.mygw.name="a"',
      "-c", 'model_providers.mygw.wire_api="responses"',
      "-c", 'model_providers.mygw.env_key_instructions="Set it\\" -c model_providers.mygw.experimental_bearer_token=\\"synthetic-inject"',
    ]);
    expect(args.filter((arg) => arg === "-c")).toHaveLength(3);
  });

  it("forwards a plain http or https endpoint as written", () => {
    for (const url of ["https://gw.example/v1", "http://localhost:8080/v1/", "https://gw.example:8443/api/v1", "https://gw.example"]) {
      expect(argsFor(`[model_providers.mygw]\nbase_url = "${url}"\n`).overrides, url).toEqual([`model_providers.mygw.base_url="${url}"`]);
    }
  });

  it("drops the whole provider when the endpoint is not a plain http or https address", () => {
    const endpoints = [
      "https://user:synthetic-pw-1@gw.example/v1", "https://synthetic-tok-2@gw.example/v1", "https://@gw.example/v1", "http://:synthetic-pw-3@gw.example/v1",
      "ftp://gw.example/v1", "file:///etc/hosts", "javascript:alert(1)", "wss://gw.example/v1", "gw.example/v1", "//gw.example/v1", "https:gw.example",
      "https://gw.example/v1?key=synthetic-q-4", "https://gw.example/v1?", "https://gw.example/v1#synthetic-frag-5", "https://gw.example/v1#",
      "https://gw.example/v 1", "https://gw.example/v1\\n", " https://gw.example/v1", "https://gw.example/\\u0007", "https://gw.example/\\u0085", "https://gw.example/\\u2028",
      "https://", "https:///v1", "https://[::1", "not a url", "",
    ];
    for (const url of endpoints) {
      const { env, args } = argsFor(`[model_providers.mygw]\nname = "GW"\nbase_url = "${url}"\nexperimental_bearer_token = "synthetic-tok-6"\nhttp_headers = { X = "synthetic-h-7" }\n`);
      expect(args, JSON.stringify(url)).toEqual([]);
      expect(Object.keys(env), JSON.stringify(url)).toEqual(["CODEX_HOME"]);
    }
    // An endpoint of the wrong type drops it too, and so does one that is only a quoted number or array.
    for (const value of ["5", "true", "[ 'https://gw.example/v1' ]", "{ url = 'https://gw.example/v1' }"]) {
      expect(argsFor(`[model_providers.mygw]\nname = "GW"\nbase_url = ${value}\n`).args, value).toEqual([]);
    }
  });

  it("forwards a text field only when it fits what the field is for", () => {
    const only = (lines: string[]) => argsFor(["[model_providers.mygw]", 'base_url = "https://gw.example/v1"', ...lines].join("\n")).overrides.slice(1);
    const text = (count: number) => "x".repeat(count);
    // name: 1 to 64 printable characters
    expect(only([`name = "${text(64)}"`])).toEqual([`model_providers.mygw.name="${text(64)}"`]);
    expect(only([`name = "${text(65)}"`])).toEqual([]);
    expect(only(['name = ""'])).toEqual([]);
    for (const bad of ["a\\nb", "a\\tb", "a\\u0007b", "a\\u001bb", "a\\u007fb", "a\\u0085b", "a\\u2028b"]) expect(only([`name = "${bad}"`]), bad).toEqual([]);
    // env_key_instructions: at most 512 characters, no control character
    expect(only([`env_key_instructions = "${text(512)}"`])).toHaveLength(1);
    expect(only([`env_key_instructions = "${text(513)}"`])).toEqual([]);
    expect(only(['env_key_instructions = "export\\nGW_KEY=x"'])).toEqual([]);
    expect(only(['env_key_instructions = "export \\u001b[0m"'])).toEqual([]);
    // env_key: an environment variable name
    expect(only(['env_key = "GW_KEY_2"'])).toEqual(['model_providers.mygw.env_key="GW_KEY_2"']);
    for (const bad of ["1GW", "GW KEY", "GW-KEY", "GW.KEY", "GW=1", "", "GW\\n"]) expect(only([`env_key = "${bad}"`]), bad).toEqual([]);
    // wire_api: responses or chat
    for (const good of ["responses", "chat"]) expect(only([`wire_api = "${good}"`])).toEqual([`model_providers.mygw.wire_api="${good}"`]);
    for (const bad of ["completions", "Responses", "responses ", "", "chat\\n"]) expect(only([`wire_api = "${bad}"`]), bad).toEqual([]);
    // a field that fails its check leaves the others alone
    expect(only(['name = "bad\\nname"', 'wire_api = "responses"', 'env_key = "1BAD"'])).toEqual(['model_providers.mygw.wire_api="responses"']);
  });

  it("forwards only the api-version query parameter, with a short plain value", () => {
    const only = (inline: string) => argsFor(`[model_providers.mygw]\nbase_url = "https://gw.example/v1"\nquery_params = ${inline}\n`).overrides.slice(1);
    expect(only("{ 'api-version' = '2026-01-01' }")).toEqual(['model_providers.mygw.query_params.api-version="2026-01-01"']);
    expect(only(`{ 'api-version' = '${"v".repeat(128)}' }`)).toHaveLength(1);
    expect(only(`{ 'api-version' = '${"v".repeat(129)}' }`)).toEqual([]);
    for (const bad of ["a b", " 1", "1 ", "", "1\\n2", "1\\u0007", "1\\u007f", "1\\u0085"]) expect(only(`{ 'api-version' = "${bad}" }`), bad).toEqual([]);
    for (const name of ["api_version", "API-VERSION", "version", "key", "api-key", "token", "model", "x-api-version"]) {
      expect(only(`{ '${name}' = 'synthetic-q' }`), name).toEqual([]);
    }
    expect(only("{ 'api-version' = '2', code = 'synthetic-q', 'x-key' = 'synthetic-q' }")).toEqual(['model_providers.mygw.query_params.api-version="2"']);
  });

  it("adds nothing for OpenAI, Codex's own providers or a provider config.toml does not declare", () => {
    const toml = '[model_providers.ollama]\nbase_url = "http://localhost:1/v1"\n[model_providers.openai]\nname = "x"\n';
    expect(argsFor(toml, "gpt-6-luna").args).toEqual([]);
    expect(argsFor(toml, "ollama::llama3").args).toEqual([]);
    expect(argsFor(toml, "absent::model").args).toEqual([]);
  });
});

describe("codexBackgroundArgs", () => {
  it("runs exec with no tools, no saved session, no user config and the prompt on stdin", () => {
    const argv = codexBackgroundArgs({ model: "gpt-6-luna", modelProvider: "openai", providerArgs: [], cwd: "/tmp/empty" });
    expect(argv[0]).toBe("exec");
    expect(argv.at(-1)).toBe("-");
    for (const flag of ["--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config"]) expect(argv).toContain(flag);
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after("--sandbox")).toBe("read-only");
    expect(after("--cd")).toBe("/tmp/empty");
    expect(after("--model")).toBe("gpt-6-luna");
    const overrides = argv.filter((_, index) => argv[index - 1] === "-c");
    expect(overrides).toEqual(expect.arrayContaining([
      `model_reasoning_effort="${CODEX_BACKGROUND_EFFORT}"`, 'approval_policy="never"', 'web_search="disabled"', 'model_provider="openai"',
      "features.shell_tool=false", "features.unified_exec=false", "features.view_image=false", "features.apps=false",
      "features.plugins=false", "features.multi_agent=false", "features.hooks=false", "features.computer_use=false",
    ]));
    expect(CODEX_BACKGROUND_EFFORT).toBe("low");
    expect(argv.some((arg) => arg.startsWith("mcp_servers"))).toBe(false);
  });
});

describe("Codex generateMemoryText (fake CLI)", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let log: string;

  const calls = (): ExecCall[] => existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ExecCall)
    : [];

  const signIn = (auth: object) => writeFileSync(join(scratch, ".codex", "auth.json"), JSON.stringify(auth));
  const chatgptLogin = () => signIn({ tokens: { refresh_token: "chatgpt-fixture" } });
  const apiKeyLogin = () => signIn({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture", tokens: null });
  const modelsRun = () => calls().map((call) => call.argv[call.argv.indexOf("--model") + 1]);
  const ownModel = (model?: string, refused: string[] = []) => {
    const onRefused = vi.fn<(model: string) => void>();
    return { onRefused, fallback: { ...(model ? { model } : {}), refused: new Set(refused), onRefused } satisfies SmallModelFallback };
  };

  const create = async (environment: Record<string, string> = {}, managed = false, endpoint = false) => {
    instance = await CodexDriver.create({
      instanceId: `codex-background-${Math.random().toString(36).slice(2)}`,
      displayName: "Codex",
      environment: {
        HOME: scratch,
        CODEX_HOME: join(scratch, ".codex"),
        FAKE_CODEX_TEXT_LOG: log,
        ...(managed ? { SEIRA_COMPANY_API_KEY: "synthetic-company-fixture" } : {}),
        ...(endpoint ? { SEIRA_CODEX_API_KEY: "synthetic-endpoint-key" } : {}),
        ...environment,
      },
      enabled: true,
      config: {
        cli: FAKE_CLI,
        fullAuto: false,
        ...(endpoint ? { endpoint: { url: "https://gateway.example/v1", models: ["gateway-model"] } } : {}),
        ...(managed ? { managed: { url: "https://company.example/v1", models: ["company-large", "gpt-6-luna"] } } : {}),
      },
    });
    return instance;
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "seira-codex-bg-test-"));
    log = join(scratch, "exec.jsonl");
    mkdirSync(join(scratch, ".codex"), { recursive: true });
  });

  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  it("is offered only as the background variant: no titles, compaction or permission review", async () => {
    const codex = await create();
    expect(codex.generateMemoryText).toBeTypeOf("function");
    expect(codex.generateText).toBeUndefined();
    expect(codex.reviewPermission).toBeUndefined();
  });

  it("asks the cheapest listed model in an empty folder, with no MCP and the prompt only on stdin", async () => {
    // the person's own Codex config declares an MCP server and a notify program
    writeFileSync(join(scratch, ".codex", "config.toml"), 'notify = ["say", "done"]\n[mcp_servers.mine]\ncommand = "mine-mcp"\n');
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_REPLY: "the answer" });
    const usage: TextGenerationUsage[] = [];
    const prompt = "You are the CAPTURE step. Secret-ish words: hunter2";
    await expect(codex.generateMemoryText!(prompt, { onUsage: (entry) => usage.push(entry) })).resolves.toBe("the answer");

    const [call] = calls();
    expect(call).toBeDefined();
    expect(call!.prompt).toBe(prompt);
    expect(call!.argv.join(" ")).not.toContain("hunter2");
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("gpt-6-luna");
    expect(call!.argv).toContain("--ignore-user-config");
    expect(call!.argv[call!.argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(call!.argv.some((arg) => arg.startsWith("mcp_servers"))).toBe(false);
    const folder = call!.argv[call!.argv.indexOf("--cd") + 1]!;
    expect(realpathSync.native(dirname(folder))).toBe(realpathSync.native(dirname(call!.cwd)));
    expect(basename(folder)).toBe(basename(call!.cwd));
    expect(basename(folder)).toMatch(/^seira-codex-background-/);
    expect(call!.cwd).not.toBe(scratch);
    expect(existsSync(call!.cwd)).toBe(false);
    expect(call!.env.CODEX_HOME).toBe(join(scratch, ".codex"));
    expect(call!.env.OPENAI_API_KEY).toBeUndefined();
    expect(usage).toEqual([{ model: "gpt-6-luna", input: 120, output: 7, cachedInput: 20 }]);
  });

  it("falls back to the account's default model when no small one is listed", async () => {
    const codex = await create();
    await codex.generateMemoryText!("hello");
    const [call] = calls();
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe(codex.models.default);
  });

  it("uses only the direct endpoint for background calls and refuses a missing key", async () => {
    const codex = await create({}, false, true);
    await codex.generateMemoryText!("hello");
    const [call] = calls();
    expect(call!.argv).toContain('model_provider="seira_endpoint"');
    expect(call!.argv).toContain('model_providers.seira_endpoint.base_url="https://gateway.example/v1"');
    expect(modelsRun()).toEqual(["gateway-model"]);
    expect(call!.env.SEIRA_CODEX_API_KEY).toBe("synthetic-endpoint-key");
    expect(JSON.stringify(call!.argv)).not.toContain("synthetic-endpoint-key");
    await codex.dispose();
    const keyless = await create({ SEIRA_CODEX_API_KEY: "" }, false, true);
    await expect(keyless.generateMemoryText!("hello")).rejects.toThrow(/Direct API key/);
  });

  it("keeps a Company's routing and approved models, and refuses without its key", async () => {
    const codex = await create({}, true);
    await codex.generateMemoryText!("hello");
    const [call] = calls();
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("gpt-6-luna");
    expect(call!.argv).toContain('model_provider="seira_company"');
    expect(call!.env.SEIRA_COMPANY_API_KEY).toBe("synthetic-company-fixture");
    await codex.dispose();
    const keyless = await create({ SEIRA_COMPANY_API_KEY: "" }, true);
    await expect(keyless.generateMemoryText!("hello")).rejects.toThrow(/Company model access is unavailable/);
  });

  it("writes on the bot's own model for a ChatGPT sign-in, which refuses the small models its catalog lists", async () => {
    chatgptLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna,gpt-5.4-mini" });
    const usage: TextGenerationUsage[] = [];
    await expect(codex.generateMemoryText!("hello", { fallback: ownModel("gpt-fake-default").fallback, onUsage: (entry) => usage.push(entry) })).resolves.toBe("fake background answer");
    await expect(codex.generateMemoryText!("hello")).resolves.toBe("fake background answer");
    expect(modelsRun()).toEqual(["gpt-fake-default", "gpt-6-astra"]);
    expect(usage).toEqual([expect.objectContaining({ model: "gpt-fake-default" })]);
  });

  it("keeps the small model for an API-key sign-in", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1" });
    const { fallback, onRefused } = ownModel("gpt-6-astra");
    await codex.generateMemoryText!("hello", { fallback });
    expect(modelsRun()).toEqual(["gpt-6-luna"]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("never picks a small model this instance already refused", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna" });
    const { fallback, onRefused } = ownModel("gpt-fake-default", ["gpt-6-luna"]);
    await codex.generateMemoryText!("hello", { fallback });
    expect(modelsRun()).toEqual(["gpt-6-astra"]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("runs once more on the bot's own model when the provider refuses the small one, and reports the refusal", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna" });
    const { fallback, onRefused } = ownModel("gpt-fake-default");
    const usage: TextGenerationUsage[] = [];
    await expect(codex.generateMemoryText!("hello", { fallback, onUsage: (entry) => usage.push(entry) })).resolves.toBe("fake background answer");
    expect(modelsRun()).toEqual(["gpt-6-luna", "gpt-fake-default"]);
    expect(onRefused.mock.calls).toEqual([["gpt-6-luna"]]);
    expect(usage).toEqual([expect.objectContaining({ model: "gpt-fake-default" })]);
  });

  it("runs only once when the bot's own model is refused, or the call failed for another reason", async () => {
    chatgptLogin();
    const refusing = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-fake-default" });
    const { fallback, onRefused } = ownModel("gpt-fake-default");
    await expect(refusing.generateMemoryText!("hello", { fallback })).rejects.toThrow(/'gpt-fake-default' model is not supported/);
    await refusing.dispose();
    apiKeyLogin();
    const failing = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_MODE: "fail" });
    await expect(failing.generateMemoryText!("hello", { fallback })).rejects.toThrow(/401/);
    expect(modelsRun()).toEqual(["gpt-fake-default", "gpt-6-luna"]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("remembers a refused small model across the bot's background jobs and restarts", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_ASTRA: "1", FAKE_CODEX_TEXT_REFUSE: "gpt-6-luna" });
    const file = join(scratch, "refused-quick-models.json");
    const jobs = (smallModels: QuickModelFallback) => createSideJobs({
      bot: () => ({ id: "b1", name: "Bot", threadId: "main-b1", modelSelection: { instanceId: codex.instanceId, model: "gpt-fake-default" } }),
      instance: () => codex,
      refusal: () => undefined,
      helper: () => null,
      smallModels,
      assertWithinBudget: () => {},
      book: () => {},
    });
    const memory = jobs(new QuickModelFallback({ file, publish: () => {}, stopped: () => false })).text("memory", "b1")!;
    await memory.generateText("first");
    await memory.generateText("second");
    await jobs(new QuickModelFallback({ file, publish: () => {}, stopped: () => false })).text("skill-review", "b1")!.generateText("after a restart");
    expect(modelsRun()).toEqual(["gpt-6-luna", "gpt-fake-default", "gpt-6-astra", "gpt-6-astra"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ [codex.instanceId]: ["gpt-6-luna"] });
  });

  it("writes on the bot's own gateway model with the gateway's provider table, never OpenAI's small model", async () => {
    apiKeyLogin();
    writeFileSync(join(scratch, ".codex", "config.toml"), [
      'model = "glm-5"', 'model_provider = "mygw"',
      "[model_providers.mygw]", 'name = "My gateway"', 'base_url = "http://127.0.0.1:9/v1"', 'env_key = "MYGW_KEY"',
    ].join("\n"));
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_BLOCK: "gpt-6-luna" });
    await expect(codex.generateMemoryText!("hello", { fallback: ownModel("mygw::glm-5").fallback })).resolves.toBe("fake background answer");
    await expect(codex.generateMemoryText!("hello")).resolves.toBe("fake background answer");
    expect(modelsRun()).toEqual(["glm-5", "glm-5"]);
    for (const { argv } of calls()) {
      expect(argv).toContain('model_provider="mygw"');
      expect(argv).toContain('model_providers.mygw.base_url="http://127.0.0.1:9/v1"');
      expect(argv).toContain("--ignore-user-config");
    }
  });

  it("runs once more on the bot's own model when OpenAI blocks this region, then goes straight there", async () => {
    apiKeyLogin();
    const codex = await create({ FAKE_CODEX_LUNA: "1", FAKE_CODEX_TEXT_BLOCK: "gpt-6-luna" });
    const { fallback, onRefused } = ownModel("gpt-fake-default");
    const usage: TextGenerationUsage[] = [];
    await expect(codex.generateMemoryText!("hello", { fallback, onUsage: (entry) => usage.push(entry) })).resolves.toBe("fake background answer");
    await expect(codex.generateMemoryText!("again", { fallback })).resolves.toBe("fake background answer");
    expect(modelsRun()).toEqual(["gpt-6-luna", "gpt-fake-default", "gpt-fake-default"]);
    expect(onRefused).not.toHaveBeenCalled();
    expect(usage).toEqual([expect.objectContaining({ model: "gpt-fake-default" })]);
  });

  it("reads past Codex's banners, notices and reasoning to the answer", async () => {
    const codex = await create({ FAKE_CODEX_TEXT_MODE: "noisy", FAKE_CODEX_TEXT_REPLY: "only this" });
    await expect(codex.generateMemoryText!("hello")).resolves.toBe("only this");
  });

  it("fails with Codex's own words when the turn fails or the process dies", async () => {
    const failing = await create({ FAKE_CODEX_TEXT_MODE: "fail" });
    await expect(failing.generateMemoryText!("hello")).rejects.toThrow(/Codex background call failed: unexpected status 401/);
    await failing.dispose();
    const dying = await create({ FAKE_CODEX_TEXT_MODE: "exit" });
    await expect(dying.generateMemoryText!("hello")).rejects.toThrow(/exited 1: Error: stream disconnected/);
  });

  it("fails closed on any tool item, before its result is read", async () => {
    const codex = await create({ FAKE_CODEX_TEXT_MODE: "tool" });
    const usage = vi.fn();
    await expect(codex.generateMemoryText!("hello", { onUsage: usage })).rejects.toThrow(/tried to use a tool \(command_execution\)/);
    expect(usage).not.toHaveBeenCalled();
  });

  it("waits as long as the caller's options say", async () => {
    const env = { ...process.env, FAKE_CODEX_TEXT_MODE: "hang", FAKE_CODEX_TEXT_LOG: log };
    const started = Date.now();
    await expect(runCodexOneShot({ spawn: spawnCli, kill: killCliTree, cli: FAKE_CLI, env, prompt: "hello", model: "gpt-6-luna", providerArgs: [], options: { timeoutMs: 1_500 } })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(CODEX_BACKGROUND_TIMEOUT_MS);
  });

  it("stops the process on timeout and on abort", async () => {
    const env = { ...process.env, FAKE_CODEX_TEXT_MODE: "hang", FAKE_CODEX_TEXT_LOG: log };
    const spawned: Array<ReturnType<typeof spawnCli>> = [];
    const spawn: typeof spawnCli = (...args) => {
      const child = spawnCli(...args);
      spawned.push(child);
      return child;
    };
    const base = { spawn, kill: killCliTree, cli: FAKE_CLI, env, prompt: "hello", model: "gpt-6-luna", providerArgs: [] };
    await expect(runCodexOneShot({ ...base, timeoutMs: 1_500 })).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    const pending = runCodexOneShot({ ...base, options: { signal: controller.signal } });
    await vi.waitFor(() => expect(calls()).toHaveLength(2), { timeout: 10_000 });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(spawned).toHaveLength(2);
    for (const child of spawned) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    for (const call of calls()) expect(existsSync(call.cwd)).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    await expect(runCodexOneShot({ ...base, options: { signal: aborted.signal } })).rejects.toThrow(/aborted/);
    expect(spawned).toHaveLength(2);
  }, 30_000);
});
