import { describe, expect, it } from "vitest";

import type { BrowserEngineKind } from "../browser/config.ts";
import type { AppConfig } from "../config.ts";
import { configEntries } from "./registry-config.ts";
import type { RegistryDeps, SettingEntry, WritableSpec } from "./registry.ts";

function current(cfg: Partial<AppConfig>, effective?: () => BrowserEngineKind): unknown {
  const deps = { cfg: () => cfg as AppConfig, browserEngine: effective } as unknown as Parameters<typeof configEntries>[0];
  const entries = configEntries(deps, (spec: WritableSpec) => spec as unknown as SettingEntry);
  const entry = entries.find((candidate) => candidate.id === "desktops.browserEngine") as unknown as { current(): unknown };
  return entry.current();
}

describe("the browser engine setting", () => {
  it("reads the engine that runs bots' browsers now, not only the saved choice", () => {
    expect(current({}, () => "chrome")).toBe("chrome");
    expect(current({ browserEngine: { engine: "agent-browser" } }, () => "agent-browser")).toBe("agent-browser");
  });

  it("falls back to the saved choice, then agent-browser, when the host does not say", () => {
    const dep: RegistryDeps["browserEngine"] = undefined;
    expect(current({ browserEngine: { engine: "chrome" } }, dep)).toBe("chrome");
    expect(current({}, dep)).toBe("agent-browser");
  });
});
