import { describe, expect, it } from "vitest";

import type { ChromeImportService } from "../browser/chrome-import/service.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBrowserSitesHost } from "./browser-sites-host.ts";

const service: ChromeImportService = {
  profiles: async () => [],
  sites: async () => ({ ticket: "t", profileName: "", browserName: "", sites: [] }),
  run: async () => ({ imported: { sites: 0, cookies: 0 }, skipped: 0, running: false, sites: [] }),
};
const loopback = { kind: "loopback", scopes: [] } as unknown as RequestAuth;
const session = { kind: "session", session: { id: "s-1" }, via: "cookie", scopes: [] } as unknown as RequestAuth;

function host(local: boolean, platform: NodeJS.Platform) {
  return createBrowserSitesHost({ target: () => ({ status: 404, error: "" }), local, owner: () => true, platform, service }).chromeImport!;
}

describe("browser sites host", () => {
  it("offers the Chrome import only on the owner's own Linux or macOS computer", () => {
    expect(host(true, "linux").enabled(loopback)).toBe(true);
    expect(host(true, "darwin").enabled(loopback)).toBe(true);
    expect(host(true, "win32").enabled(loopback)).toBe(false);
    expect(host(false, "linux").enabled(loopback)).toBe(false);
  });

  it("names each requester apart, so a ticket works only for the one who asked", () => {
    const gate = host(true, "linux");
    expect(gate.caller(loopback)).toBe("loopback");
    expect(gate.caller(session)).toBe("session:s-1");
  });
});
