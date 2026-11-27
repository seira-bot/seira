import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import { createSettingsRegistry, type RegistryDeps, type WritableEntry } from "./registry.ts";

function enginesEntry(added: Array<{ path: string; body: Record<string, unknown> }>) {
  const config = { anthropic: { url: "https://api.anthropic.com" } } as unknown as AppConfig;
  const entries = createSettingsRegistry({
    cfg: () => config, saveConfig: async () => null, bots: () => [] as BotRecord[], sections: () => [], reorderBots: async () => null, groupBots: async () => null,
    pinBot: async () => null, patchBot: async () => null, call: async () => null, read: async () => null, paused: () => [], credentials: () => config as never,
    threadModes: () => ({}), setThreadModes: async () => null, threadModeRefusal: () => null,
    window: { read: () => undefined, write: () => null }, engines: () => [],
    addEngine: async (path: string, body: Record<string, unknown>) => { added.push({ path, body }); return null; }, removeEngine: async () => null,
  } as unknown as RegistryDeps);
  return entries.find((candidate) => candidate.id === "engines") as WritableEntry;
}

describe("a local-server engine a bot adds", () => {
  it("waits for the owner's tap when its address is not on this computer", async () => {
    const added: Array<{ path: string; body: Record<string, unknown> }> = [];
    const entry = enginesEntry(added);
    for (const url of ["https://collector.example/v1", "http://203.0.113.9:11434", "http://192.168.1.20:1234/v1"]) {
      for (const kind of ["ollama", "lmstudio"]) {
        expect(entry.confirm?.({ kind, url }), `${kind} ${url}`).toEqual({ code: "dataTo", params: { provider: new URL(url).host } });
      }
    }
  });

  it("waits when the host only looks like this computer, or is not a loopback address", () => {
    const entry = enginesEntry([]);
    for (const url of ["http://localhost.example", "http://127.0.0.1.nip.io", "http://0.0.0.0:11434", "http://10.0.0.5:11434", "http://169.254.169.254", "http://[fd00::1]:11434", "http://[::ffff:127.0.0.1]:11434", "not a url"]) {
      for (const kind of ["ollama", "lmstudio"]) {
        expect(entry.confirm?.({ kind, url }), `${kind} ${url}`).toMatchObject({ code: "dataTo" });
      }
    }
  });

  it("does not wait when the address is this computer", () => {
    const entry = enginesEntry([]);
    for (const url of ["http://127.0.0.1:11434", "http://localhost:1234/v1", "http://[::1]:11434", "http://127.1.2.3:11434"]) {
      for (const kind of ["ollama", "lmstudio"]) {
        expect(entry.confirm?.({ kind, url }), `${kind} ${url}`).toBeNull();
      }
    }
  });
});
