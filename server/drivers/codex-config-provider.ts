// `codex exec --ignore-user-config` skips config.toml and every provider the person declared there: a background
// call on one fails with "Model provider `x` not found" (codex-cli 0.167). Such a call carries the provider's own
// table as `-c` overrides. The file is read by a standards-compliant TOML parser, whatever way the person wrote the
// table (dotted keys, a subtable, an inline table). The overrides are built from the parsed values only, never from
// the text of the file: a field outside the list below, a value of the wrong type, or a file that does not parse
// adds nothing. A bearer token, and the value of a header in `http_headers`, go into the child's environment, not argv.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

import { isSecretName } from "../redact.ts";
import { decodeCodexSelection } from "./codex-catalog.ts";
import { codexHome } from "./codex-identity.ts";

/** Providers Codex defines itself. */
const BUILT_IN = new Set(["openai", "oss", "ollama", "lmstudio"]);
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** The fields of a Codex provider table the background call may carry, each with the one type it may have. */
const STRING_FIELDS = new Set(["name", "base_url", "env_key", "env_key_instructions", "wire_api"]);
const BOOLEAN_FIELDS = new Set(["requires_openai_auth"]);
const INTEGER_FIELDS = new Set(["request_max_retries", "stream_max_retries", "stream_idle_timeout_ms"]);

export function codexConfigProviderArgs(env: Record<string, string | undefined>, modelId: string | null | undefined): string[] {
  const provider = decodeCodexSelection(modelId).modelProvider;
  const home = codexHome(env);
  if (!provider || BUILT_IN.has(provider) || !BARE_KEY.test(provider) || !home) return [];
  let profiles: string[] = [];
  try {
    profiles = readdirSync(home).filter((file) => file.endsWith(".config.toml")).sort();
  } catch {}
  for (const file of ["config.toml", ...profiles]) {
    const table = providerTable(join(home, file), provider);
    if (table && Object.keys(table).length) return overrides(env, provider, table);
  }
  return [];
}

/** The parsed `model_providers.<id>` table of one file; null when the file is missing, does not parse, or has none. */
function providerTable(path: string, provider: string): Table | null {
  let parsed: Table;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const providers = Object.hasOwn(parsed, "model_providers") ? parsed.model_providers : undefined;
  const table = isTable(providers) && Object.hasOwn(providers, provider) ? providers[provider] : undefined;
  return isTable(table) ? table : null;
}

/** A TOML basic string. `JSON.stringify` writes a valid one, except that DEL must be escaped in TOML. */
const tomlString = (value: string) => JSON.stringify(value).replace(/\u007f/g, "\\u007f");

/** A table whose every entry is a string under a plain key. An entry of another shape is left out. */
function stringEntries(value: unknown): [string, string][] {
  if (!isTable(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, string] => BARE_KEY.test(entry[0]) && typeof entry[1] === "string");
}

function overrides(env: Record<string, string | undefined>, provider: string, table: Table): string[] {
  const args: string[] = [];
  const variable = (suffix: string) => `SEIRA_CODEX_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
  const set = (key: string, literal: string) => args.push("-c", `model_providers.${provider}.${key}=${literal}`);
  const bearer = typeof table.experimental_bearer_token === "string" ? table.experimental_bearer_token : null;
  let headers = 0;
  for (const [field, value] of Object.entries(table)) {
    if (STRING_FIELDS.has(field)) {
      // With a token, `env_key` is ours: the person's own name for it is not forwarded.
      if (typeof value === "string" && !(field === "env_key" && bearer !== null)) set(field, tomlString(value));
    } else if (BOOLEAN_FIELDS.has(field)) {
      if (typeof value === "boolean") set(field, String(value));
    } else if (INTEGER_FIELDS.has(field)) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) set(field, String(value));
    } else if (field === "http_headers") {
      for (const [name, header] of stringEntries(value)) {
        const key = variable(`HEADER_${++headers}`);
        env[key] = header;
        set(`env_http_headers.${name}`, tomlString(key));
      }
    } else if (field === "env_http_headers") {
      for (const [name, key] of stringEntries(value)) if (ENV_NAME.test(key)) set(`env_http_headers.${name}`, tomlString(key));
    } else if (field === "query_params") {
      // A query parameter whose name says credential is dropped: the address is not a place for one.
      for (const [name, param] of stringEntries(value)) if (!isSecretName(name) && !/^(?:auth|sig|signature|pass|pwd|code)$/i.test(name)) set(`query_params.${name}`, tomlString(param));
    }
  }
  if (bearer !== null) {
    env[variable("TOKEN")] = bearer;
    set("env_key", tomlString(variable("TOKEN")));
  }
  return args;
}
