// Native protocol logs keep the shape of credentials, never their values: they get pasted into issues.

const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "seira_gate_upstream" || lower === "seira_remote_mcp_server" || lower.startsWith("seira_remote_mcp_config_")) return true;
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

import { RESERVED_MCP_NAMES } from "../shared/mcp-name.ts";
import { mask, redactSecretsInText } from "../shared/redact.ts";

export { addHeldSecretScrubber, HELD_SECRET_MASK, mask, redactParams, redactSecretsInText, scrubHeldSecrets } from "../shared/redact.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A value in a custom MCP server's `env` or `headers`: the name says nothing about what it holds, so every value goes. */
function maskEveryValue(input: unknown, depth: number): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return mask(input);
  if (typeof input === "number" || typeof input === "boolean") return mask(String(input));
  if (depth > 12 || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((item) => {
      // ACP shape: [{ name, value }].
      if (isRecord(item)) return "value" in item ? { ...item, value: maskEveryValue(item.value, depth + 1) } : maskEveryValue(item, depth + 1);
      // A "NAME=value" string keeps its name.
      if (typeof item === "string") {
        const eq = item.indexOf("=");
        return eq > 0 ? `${item.slice(0, eq + 1)}${mask(item.slice(eq + 1))}` : mask(item);
      }
      return maskEveryValue(item, depth + 1);
    });
  }
  // Claude shape: { NAME: value }.
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, maskEveryValue(value, depth + 1)]));
}

function redactMcpServer(server: unknown, name: unknown, depth: number): unknown {
  // Seira's own servers carry credentials under names that `isSecretName` knows; the rest of their env is plain config.
  if (!isRecord(server) || (typeof name === "string" && RESERVED_MCP_NAMES.has(name))) return redactSecrets(server, depth);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(server)) {
    out[key] = key === "env" || key === "headers" ? maskEveryValue(value, depth + 1) : redactSecrets(value, depth + 1);
  }
  return out;
}

/** `mcpServers` is an array of `{ name, ... }` in ACP and a record keyed by name in Claude's config. */
function redactMcpServers(input: unknown, depth: number): unknown {
  if (depth > 12) return input;
  if (Array.isArray(input)) return input.map((server) => redactMcpServer(server, isRecord(server) ? server.name : undefined, depth + 1));
  if (isRecord(input)) return Object.fromEntries(Object.entries(input).map(([name, server]) => [name, redactMcpServer(server, name, depth + 1)]));
  return redactSecrets(input, depth);
}

export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
  if (depth > 12 || input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        // A non-secret name does not clear the value: it still gets the content pass.
        return isSecretName(entry.name)
          ? { ...entry, value: mask(entry.value) }
          : { ...entry, value: redactSecretsInText(entry.value) };
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    if (key === "mcpServers") {
      out[key] = redactMcpServers(value, depth + 1);
      continue;
    }
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}
