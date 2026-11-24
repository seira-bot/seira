import { describe, expect, it } from "vitest";

import { browserEngineChoice, browserEngineConfigSchema, effectiveBrowserEngine, seiraEngineByDefault } from "./config.ts";

describe("browser engine proxy configuration", () => {
  it("accepts an unauthenticated SOCKS5 endpoint", () => {
    expect(browserEngineConfigSchema.parse({ egress: { proxy: "socks5://127.0.0.1:1080" } }).egress?.proxy)
      .toBe("socks5://127.0.0.1:1080");
  });

  it("rejects credentials, other protocols, and invalid ports", () => {
    for (const proxy of ["http://127.0.0.1:8080", "socks5://user:pass@proxy.example:1080", "socks5://proxy.example:0", "socks5://proxy.example:65536", "socks5://..example:1080", "socks5://[:::]:1080"]) {
      expect(browserEngineConfigSchema.safeParse({ egress: { proxy } }).success, proxy).toBe(false);
    }
  });
});

describe("the engine that runs the bots' browsers", () => {
  const has = (chrome: boolean) => () => chrome;
  const app = { env: {} };

  it("is Seira's own driver when nothing is chosen and this host has a Chrome for it", () => {
    expect(browserEngineChoice({})).toBeNull();
    expect(effectiveBrowserEngine({}, has(true), app)).toBe("chrome");
    expect(effectiveBrowserEngine({ browserEngine: { idleTimeoutMinutes: 5 } }, has(true), app)).toBe("chrome");
  });

  it("is agent-browser when nothing is chosen and this host has no Chrome for Seira's driver", () => {
    expect(effectiveBrowserEngine({}, has(false), app)).toBe("agent-browser");
  });

  it("is the engine SEIRA_BROWSER_ENGINE_DEFAULT names while nothing is chosen", () => {
    expect(effectiveBrowserEngine({}, has(true), { env: { SEIRA_BROWSER_ENGINE_DEFAULT: "agent-browser" } })).toBe("agent-browser");
    expect(effectiveBrowserEngine({}, has(false), { env: { SEIRA_BROWSER_ENGINE_DEFAULT: "chrome" } })).toBe("agent-browser");
    expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, has(true), { env: { SEIRA_BROWSER_ENGINE_DEFAULT: "agent-browser" } })).toBe("chrome");
  });

  it("stays agent-browser by default under a test unless the test asks for Seira's driver", () => {
    expect(seiraEngineByDefault({})).toBe(true);
    for (const env of [{ VITEST: "true" }, { SEIRA_TEST_SEALED_PATH: "1" }]) {
      expect(effectiveBrowserEngine({}, has(true), { env }), JSON.stringify(env)).toBe("agent-browser");
      expect(effectiveBrowserEngine({}, has(true), { env: { ...env, SEIRA_BROWSER_ENGINE_DEFAULT: "chrome" } }), JSON.stringify(env)).toBe("chrome");
      expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, has(true), { env }), JSON.stringify(env)).toBe("chrome");
    }
  });

  it("is agent-browser when the person chose it, even where Seira's driver has a Chrome", () => {
    expect(effectiveBrowserEngine({ browserEngine: { engine: "agent-browser" } }, has(true))).toBe("agent-browser");
  });

  it("is Seira's own driver when the person chose it, without asking the host", () => {
    let asked = false;
    expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, () => { asked = true; return false; })).toBe("chrome");
    expect(asked).toBe(false);
  });

  it("is agent-browser when the host boxes its browsers, whatever is chosen or found", () => {
    expect(effectiveBrowserEngine({}, has(true), { boxed: true, ...app })).toBe("agent-browser");
    expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, has(true), { boxed: true })).toBe("agent-browser");
    expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, has(true), { boxed: false })).toBe("chrome");
  });
});
