import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { connectedApps, grantImportedApps, requiredAppsOf } from "./import-apps";

const imported = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id, color: "blue", composio: false, connectorTools: {}, modelSelection: { instanceId: "claude", model: "m" }, ...extra }) as unknown as Bot;

describe("requiredAppsOf", () => {
  it("reads the apps a package needs, and nothing from another value", () => {
    const document = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));
    expect(requiredAppsOf(document)).toEqual([{ slug: "hubspot", label: expect.any(String) }]);
    expect(requiredAppsOf({ format: "seira.team" })).toEqual([]);
    expect(requiredAppsOf(null)).toEqual([]);
  });
});

describe("connectedApps", () => {
  it("keeps only apps with an active account", () => {
    const apps = [{ slug: "gmail", label: "Gmail" }, { slug: "slack", label: "Slack" }, { slug: "notion", label: "Notion" }];
    expect(connectedApps(apps, { gmail: { connected: true }, slack: { connected: false } })).toEqual([apps[0]]);
  });
});

describe("grantImportedApps", () => {
  it("turns apps on for each new bot with only the chosen apps", () => {
    const dispatch = vi.fn();
    grantImportedApps([imported("a"), imported("b")], ["gmail", "slack"], dispatch);
    const patch = { composio: true, connectorScopes: { apps: { gmail: "write", slack: "write" } }, connectorTools: { gmail: { tools: "*" }, slack: { tools: "*" } } };
    expect(dispatch.mock.calls).toEqual([
      [{ type: "updateBot", botId: "a", patch }],
      [{ type: "updateBot", botId: "b", patch }],
    ]);
  });

  it("changes nothing when no app is chosen", () => {
    const dispatch = vi.fn();
    grantImportedApps([imported("a")], [], dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
